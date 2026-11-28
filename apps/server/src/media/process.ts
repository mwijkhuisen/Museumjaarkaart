import sharp from 'sharp';
import { PHOTO_MAX_PIXELS, variantWidths } from './limits.ts';
import type { DecodeCode } from './task.ts';
import type { Decoded, SourceFormat, Variant } from './types.ts';

// The photo decoder (A§12, A§16.2 "Malicious uploads"): the only module that imports sharp, loaded only by the
// `media` role (no network, no secret, no database; plan §1 Q1). The untrusted file is decoded once, into raw
// sRGB pixels at the largest width we keep; every variant is encoded from those raw pixels, so no metadata of the
// source (EXIF, GPS, XMP, IPTC, ICC, comments, text chunks) can reach an output. One overall budget is split
// across the pipelines through sharp's own timeout.

// One libvips worker thread, no operation cache (it would keep decoded pixels of an earlier photo alive).
sharp.concurrency(1);
sharp.cache(false);
// Every loader blocked, then only the three file loaders sharp uses for a path (libvips 8.18.7, proven in
// test/media/process.test.ts: an SVG, a TIFF, a GIF and an AVIF are refused).
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegFile', 'VipsForeignLoadPngFile', 'VipsForeignLoadWebpFile'] });

export type DecodeResult = ({ ok: true } & Decoded) | { ok: false; code: DecodeCode };

const INPUT = { limitInputPixels: PHOTO_MAX_PIXELS, pages: 1, failOn: 'warning' } as const;

class Failed extends Error {
  readonly code: DecodeCode;
  constructor(code: DecodeCode) {
    super(code);
    this.code = code;
  }
}

/** What is left of the budget, in whole seconds for sharp's timeout (0 would mean none). */
function secondsLeft(deadlineMs: number): number {
  const s = Math.floor((deadlineMs - Date.now()) / 1000);
  if (s < 1) throw new Failed('media_timeout');
  return s;
}

/** sharp's error texts are libvips' own; only a fixed code leaves this module. */
function classify(err: unknown): DecodeCode {
  if (err instanceof Failed) return err.code;
  const text = err instanceof Error ? err.message : '';
  if (text.includes('pixel limit')) return 'media_too_many_pixels';
  if (text.includes('unsupported image format')) return 'media_format_mismatch';
  if (text.includes('timeout')) return 'media_timeout';
  return 'media_decode_failed';
}

/**
 * Decodes `path` (which must be `expect`) and encodes an AVIF and a WebP per width of `variantWidths`, never
 * upscaled, with no metadata. `deadlineMs` is the absolute end of the budget (epoch ms).
 */
export async function decodeSource(path: string, expect: SourceFormat, deadlineMs: number): Promise<DecodeResult> {
  try {
    const meta = await sharp(path, INPUT).metadata();
    if (meta.width * meta.height > PHOTO_MAX_PIXELS) throw new Failed('media_too_many_pixels');
    if (meta.format !== expect) throw new Failed('media_format_mismatch');
    const { width, height } = meta.autoOrient;
    const widths = variantWidths(width);
    const top = widths[widths.length - 1] as number;

    const raw = await sharp(path, INPUT)
      .autoOrient()
      .resize({ width: top, withoutEnlargement: true })
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .timeout({ seconds: secondsLeft(deadlineMs) })
      .toBuffer({ resolveWithObject: true });
    const input = {
      limitInputPixels: PHOTO_MAX_PIXELS,
      raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels },
    };

    const variants: Variant[] = [];
    for (const w of widths) {
      for (const format of ['avif', 'webp'] as const) {
        const resized = sharp(raw.data, input).resize({ width: w, withoutEnlargement: true });
        const encoded = format === 'avif' ? resized.avif() : resized.webp();
        const bytes = await encoded.timeout({ seconds: secondsLeft(deadlineMs) }).toBuffer();
        variants.push({ format, width: w, bytes });
      }
    }
    return { ok: true, width, height, variants };
  } catch (err) {
    return { ok: false, code: classify(err) };
  }
}
