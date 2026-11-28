import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSource } from '../../src/media/process.ts';
import { checkVariant, expectedHeight } from '../../src/media/variant-check.ts';
import { canaryJpeg, noise, rotatedJpeg } from './images.ts';

// The worker's container check of the `media` role's output (P3b security review M2): sharp's own outputs pass,
// anything with metadata, animation, a second image, extra bytes or other dimensions fails, and nothing throws.

const alpha = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } });

const buf = (p: Sharp) => p.toBuffer();

/** A WebP with its RIFF size fixed after an edit. */
function riff(chunks: Buffer): Buffer {
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(chunks.length + 4, 4);
  return Buffer.concat([head, chunks]);
}
const chunk = (type: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.write(type, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

/** The offset of the first top-level box of this type in an AVIF. */
function boxAt(b: Buffer, type: string): number {
  for (let o = 0; o < b.length; o += b.readUInt32BE(o)) if (b.toString('latin1', o + 4, o + 8) === type) return o;
  throw new Error(`no ${type}`);
}

describe('expectedHeight', () => {
  // Measured against sharp 0.35.5's resize({ width }) (libvips rounds to nearest).
  it.each([
    [4000, 2999, 400, 300],
    [4000, 2999, 1200, 900],
    [4000, 2999, 2000, 1500],
    [1001, 667, 400, 267],
    [2999, 1999, 2000, 1333],
    [1999, 1001, 400, 200],
    [1999, 1001, 1200, 601],
    [401, 3, 400, 3],
    [3, 1000, 3, 1000],
    [2000, 1, 400, 1],
  ])(
    '%i×%i to %i is %i high',
    async (w, h, to, want) => {
      expect(expectedHeight(w, h, to)).toBe(want);
      if (w * h <= 12_000_000) {
        const got = await noise(w, h)
          .resize({ width: to, withoutEnlargement: true })
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(got.info.height).toBe(want);
      }
    },
    30_000,
  );
});

describe('sharp outputs pass', () => {
  it.each([
    [64, 48],
    [400, 267],
    [3, 1000],
    [1200, 1],
  ])('opaque %i×%i, AVIF and WebP', async (w, h) => {
    expect(checkVariant(await buf(noise(w, h).avif()), 'avif', w, h)).toBe(true);
    expect(checkVariant(await buf(noise(w, h).webp()), 'webp', w, h)).toBe(true);
    // ±1 on the height (the variants come from the resized top width, not the source).
    expect(checkVariant(await buf(noise(w, h).webp()), 'webp', w, h + 1)).toBe(true);
  });

  it('with alpha, AVIF (an auxiliary item) and WebP (VP8X, ALPH)', async () => {
    expect(checkVariant(await buf(alpha(64, 48).avif()), 'avif', 64, 48)).toBe(true);
    expect(checkVariant(await buf(alpha(64, 48).webp()), 'webp', 64, 48)).toBe(true);
  });

  it('lossless WebP (VP8L)', async () => {
    expect(checkVariant(await buf(noise(64, 48).webp({ lossless: true })), 'webp', 64, 48)).toBe(true);
  });

  describe('every variant of the decoder', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'mjk-variant-check-'));
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it.each([
      ['a 4000×2999 JPEG', () => noise(4000, 2999).jpeg().toBuffer(), 'jpeg'],
      ['a rotated JPEG', rotatedJpeg, 'jpeg'],
      ['a JPEG full of metadata', canaryJpeg, 'jpeg'],
      ['a PNG with alpha', () => alpha(1999, 1001).png().toBuffer(), 'png'],
    ] as const)(
      '%s',
      async (name, make, format) => {
        const path = join(dir, name.replaceAll(' ', '-'));
        await writeFile(path, await make());
        const r = await decodeSource(path, format, Date.now() + 60_000);
        if (!r.ok) throw new Error(r.code);
        for (const v of r.variants) {
          expect(checkVariant(v.bytes, v.format, v.width, expectedHeight(r.width, r.height, v.width))).toBe(true);
        }
      },
      60_000,
    ); // a 12 MP decode into six variants: about 5 s on CI's runner, past Vitest's default 5 s
  });
});

describe('everything else fails', () => {
  it('sharp outputs with EXIF, XMP or ICC', async () => {
    for (const format of ['avif', 'webp'] as const) {
      const base = () => (format === 'avif' ? noise(64, 48).avif() : noise(64, 48).webp());
      for (const p of [
        base().withMetadata(),
        base().withExif({ IFD0: { Copyright: 'x' } }),
        base().withIccProfile('p3'),
        base().keepIccProfile().withIccProfile('srgb'),
        base().withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'),
      ]) {
        expect(checkVariant(await buf(p), format, 64, 48)).toBe(false);
      }
    }
  });

  it('the wrong dimensions or format', async () => {
    const webp = await buf(noise(64, 48).webp());
    const avif = await buf(noise(64, 48).avif());
    for (const [bytes, format] of [
      [webp, 'webp'],
      [avif, 'avif'],
    ] as const) {
      expect(checkVariant(bytes, format, 65, 48)).toBe(false);
      expect(checkVariant(bytes, format, 64, 50)).toBe(false);
      expect(checkVariant(bytes, format, 64, 46)).toBe(false);
      expect(checkVariant(bytes, format, 0, 48)).toBe(false);
    }
    expect(checkVariant(webp, 'avif', 64, 48)).toBe(false);
    expect(checkVariant(avif, 'webp', 64, 48)).toBe(false);
    // An alpha AVIF whose alpha item is another size: every ispe must be right.
    expect(checkVariant(await buf(alpha(64, 48).avif()), 'avif', 64, 40)).toBe(false);
  });

  it('WebP: trailing bytes, an extra chunk, a VP8X flag, animation, truncation', async () => {
    const plain = await buf(noise(64, 48).webp());
    const withA = await buf(alpha(64, 48).webp());
    const body = plain.subarray(12);
    expect(checkVariant(Buffer.concat([plain, Buffer.alloc(2)]), 'webp', 64, 48)).toBe(false);
    expect(checkVariant(riff(Buffer.concat([body, Buffer.alloc(2)])), 'webp', 64, 48)).toBe(false);
    for (const type of ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'JUNK']) {
      expect(checkVariant(riff(Buffer.concat([body, chunk(type, Buffer.from('MJK'))])), 'webp', 64, 48)).toBe(false);
    }
    // Two image chunks.
    expect(checkVariant(riff(Buffer.concat([body, body])), 'webp', 64, 48)).toBe(false);
    // VP8X flags other than alpha: ICC 0x20, EXIF 0x08, XMP 0x04, animation 0x02.
    expect(checkVariant(withA, 'webp', 64, 48)).toBe(true);
    for (const flag of [0x20, 0x08, 0x04, 0x02, 0x01]) {
      const b = Buffer.from(withA);
      b[20] = 0x10 | flag;
      expect(checkVariant(b, 'webp', 64, 48), `flag ${flag}`).toBe(false);
    }
    // ALPH without VP8X.
    const alph = withA.subarray(12 + 18);
    expect(checkVariant(riff(Buffer.from(alph)), 'webp', 64, 48)).toBe(false);
    expect(checkVariant(plain.subarray(0, plain.length - 1), 'webp', 64, 48)).toBe(false);
  });

  it('AVIF: an extra box, data in mdat no item names, a metadata OBU, truncation', async () => {
    const plain = await buf(noise(64, 48).avif());
    const free = Buffer.from('\0\0\0\x0cfreeMJK!', 'latin1');
    expect(checkVariant(Buffer.concat([plain, free]), 'avif', 64, 48)).toBe(false);
    expect(checkVariant(Buffer.concat([plain, Buffer.alloc(3)]), 'avif', 64, 48)).toBe(false);
    // mdat grown by bytes that no iloc extent covers.
    const grown = Buffer.concat([plain, Buffer.from('MJK!', 'latin1')]);
    const mdat = boxAt(plain, 'mdat');
    grown.writeUInt32BE(grown.readUInt32BE(mdat) + 4, mdat);
    expect(checkVariant(grown, 'avif', 64, 48)).toBe(false);
    // The temporal delimiter OBU (type 2) turned into a metadata OBU (type 5).
    const meta = Buffer.from(plain);
    expect(meta[mdat + 8]).toBe(0x12);
    meta[mdat + 8] = (5 << 3) | 2;
    expect(checkVariant(meta, 'avif', 64, 48)).toBe(false);
    // An extra box inside meta.
    const m = boxAt(plain, 'meta');
    const inMeta = Buffer.concat([plain.subarray(0, m + 12), free, plain.subarray(m + 12)]);
    inMeta.writeUInt32BE(inMeta.readUInt32BE(m) + free.length, m);
    expect(checkVariant(inMeta, 'avif', 64, 48)).toBe(false);
    expect(checkVariant(plain.subarray(0, plain.length - 1), 'avif', 64, 48)).toBe(false);
  });

  it('never throws on a truncated or corrupted file', async () => {
    const files = [
      [await buf(noise(64, 48).webp()), 'webp'],
      [await buf(alpha(64, 48).webp()), 'webp'],
      [await buf(noise(64, 48).avif()), 'avif'],
      [await buf(alpha(64, 48).avif()), 'avif'],
    ] as const;
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (const [bytes, format] of files) {
      for (let n = 0; n < bytes.length; n++) expect(checkVariant(bytes.subarray(0, n), format, 64, 48)).toBe(false);
      for (let i = 0; i < 2000; i++) {
        const b = Buffer.from(bytes);
        for (let k = 0; k < 1 + (i % 4); k++) b[rand() % b.length] = rand() % 256;
        expect(typeof checkVariant(b, format, 64, 48)).toBe('boolean');
      }
    }
  });
});
