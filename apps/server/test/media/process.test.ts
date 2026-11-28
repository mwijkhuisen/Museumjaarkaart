import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DecodeResult, decodeSource } from '../../src/media/process.ts';
import type { SourceFormat } from '../../src/media/types.ts';
import {
  avif,
  bombPng,
  CANARY,
  canaryJpeg,
  canaryPng,
  gif,
  iccJpeg,
  noise,
  plainPng,
  polyglotJpeg,
  rotatedJpeg,
  svg,
  tiff,
  truncatedJpeg,
} from './images.ts';

// The sharp pipeline of the `media` role (P3b criterion 2): no metadata survives, never upscaled, the widths, the
// blocked loaders and the fixed failure codes. No database.

let dir: string;
const later = () => Date.now() + 60_000;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mjk-process-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function decode(
  name: string,
  bytes: Buffer,
  expectFormat: SourceFormat,
  deadline = later(),
): Promise<DecodeResult> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return decodeSource(path, expectFormat, deadline);
}

function ok(r: DecodeResult) {
  if (!r.ok) throw new Error(`decode failed: ${r.code}`);
  return r;
}

/** Metadata read through the buffer loaders, which the decoder itself never uses (it reads a path, then raw). */
async function bufferMeta(bytes: Uint8Array) {
  sharp.unblock({
    operation: [
      'VipsForeignLoadJpegBuffer',
      'VipsForeignLoadPngBuffer',
      'VipsForeignLoadWebpBuffer',
      'VipsForeignLoadHeifBuffer',
    ],
  });
  return sharp(bytes).metadata();
}

async function expectClean(r: DecodeResult & { ok: true }) {
  for (const v of r.variants) {
    expect(Buffer.from(v.bytes).includes(CANARY), `${v.width}.${v.format}`).toBe(false);
    expect((await fileTypeFromBuffer(v.bytes))?.mime).toBe(v.format === 'avif' ? 'image/avif' : 'image/webp');
    const m = await bufferMeta(v.bytes);
    expect(m.width).toBe(v.width);
    expect({ exif: m.exif, xmp: m.xmp, iptc: m.iptc, icc: m.icc }).toEqual({
      exif: undefined,
      xmp: undefined,
      iptc: undefined,
      icc: undefined,
    });
  }
}

describe('decodeSource', () => {
  it('drops the canary from EXIF, GPS, XMP, IPTC and COM of a JPEG', async () => {
    const src = await canaryJpeg();
    // The fixture is well-formed: libvips itself finds every block.
    const m = await bufferMeta(src);
    expect([m.exif, m.xmp, m.iptc].map((b) => b?.includes(CANARY))).toEqual([true, true, true]);
    const r = ok(await decode('canary.jpg', src, 'jpeg'));
    expect([r.width, r.height]).toEqual([600, 400]);
    expect(r.variants.map((v) => `${v.width}.${v.format}`)).toEqual(['400.avif', '400.webp', '600.avif', '600.webp']);
    await expectClean(r);
  });

  it('drops the canary from tEXt, iTXt and eXIf of a PNG', async () => {
    const src = await canaryPng();
    const m = await bufferMeta(src);
    expect(m.exif?.includes(CANARY)).toBe(true);
    expect(m.comments?.filter((c) => c.text.includes(CANARY))).toHaveLength(2);
    await expectClean(ok(await decode('canary.png', src, 'png')));
  });

  it('drops an embedded ICC profile', async () => {
    expect((await bufferMeta(await iccJpeg())).icc).toBeDefined();
    await expectClean(ok(await decode('icc.jpg', await iccJpeg(), 'jpeg')));
  });

  it('applies the EXIF orientation and reports the oriented size', async () => {
    const r = ok(await decode('rotated.jpg', await rotatedJpeg(), 'jpeg'));
    expect([r.width, r.height]).toEqual([400, 600]);
    expect(r.variants.map((v) => v.width)).toEqual([400, 400]);
    await expectClean(r);
  });

  it('never upscales a small source', async () => {
    const r = ok(await decode('small.png', await noise(64, 48).png().toBuffer(), 'png'));
    expect(r.variants.map((v) => `${v.width}.${v.format}`)).toEqual(['64.avif', '64.webp']);
    await expectClean(r);
  });

  it('caps a large source at 2000 px and makes every planned width', async () => {
    const r = ok(await decode('large.webp', await noise(2400, 1200).webp().toBuffer(), 'webp'));
    expect([r.width, r.height]).toEqual([2400, 1200]);
    expect(r.variants.map((v) => v.width)).toEqual([400, 400, 1200, 1200, 2000, 2000]);
    await expectClean(r);
  }, 30_000);

  it('keeps no HTML of a JPEG + HTML polyglot', async () => {
    const r = ok(await decode('polyglot.jpg', await polyglotJpeg(), 'jpeg'));
    for (const v of r.variants) expect(Buffer.from(v.bytes).includes('<html')).toBe(false);
  });

  it('fails a decompression bomb with the pixel-limit code', async () => {
    const bomb = bombPng();
    expect(bomb.length).toBeLessThan(1000);
    expect(await decode('bomb.png', bomb, 'png')).toEqual({ ok: false, code: 'media_too_many_pixels' });
  });

  it('fails a truncated JPEG', async () => {
    expect(await decode('truncated.jpg', await truncatedJpeg(), 'jpeg')).toEqual({
      ok: false,
      code: 'media_decode_failed',
    });
  });

  it('fails a PNG declared as a JPEG', async () => {
    expect(await decode('png.jpg', await plainPng(), 'jpeg')).toEqual({ ok: false, code: 'media_format_mismatch' });
  });

  it('fails when the budget is spent', async () => {
    expect(await decode('late.jpg', await canaryJpeg(), 'jpeg', Date.now() + 500)).toEqual({
      ok: false,
      code: 'media_timeout',
    });
  });
});

describe('the blocked loaders', () => {
  const cases = [
    ['svg', svg],
    ['tiff', tiff],
    ['gif', gif],
    ['avif', avif],
  ] as const;

  it.each(cases)('refuses a %s file even when the expected format is forced', async (name, make) => {
    // libvips can read it: only the block refuses it.
    expect(sharp.format[name === 'avif' ? 'heif' : name].input.file).toBe(true);
    const path = join(dir, `blocked.${name}`);
    await writeFile(path, await make());
    await expect(sharp(path).metadata()).rejects.toThrow(/unsupported image format/);
    for (const forced of ['jpeg', 'png', 'webp'] as const) {
      expect(await decodeSource(path, forced, later())).toEqual({ ok: false, code: 'media_format_mismatch' });
    }
  });
});
