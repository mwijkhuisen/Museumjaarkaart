import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

// Hostile and ordinary source images for the decoder's tests (P3b WP3), built in the test: no binary blob in git.
// Every metadata block carries CANARY, so "the canary is in no byte of any variant" means each was dropped.

export const CANARY = 'MJKCANARY7f3a9c';

/** A noisy RGB image (so the encoders have something to do), as a sharp pipeline. */
export const noise = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#4a6b8c', noise: { type: 'gaussian', mean: 128, sigma: 8 } },
  });

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A big-endian TIFF header with IFD0 (ImageDescription, a GPS IFD pointer) and a GPS IFD (GPSMapDatum). */
export function exifTiff(text: string): Buffer {
  const s = Buffer.from(`${text}\0`, 'latin1');
  const entry = (tag: number, type: number, count: number, value: number) =>
    Buffer.concat([u16(tag), u16(type), u32(count), u32(value)]);
  const ifd0At = 8;
  const gpsAt = ifd0At + 2 + 2 * 12 + 4;
  const descAt = gpsAt + 2 + 12 + 4;
  const datumAt = descAt + s.length;
  return Buffer.concat([
    Buffer.from('MM\0*', 'latin1'),
    u32(ifd0At),
    u16(2),
    entry(0x010e, 2, s.length, descAt),
    entry(0x8825, 4, 1, gpsAt),
    u32(0),
    u16(1),
    entry(0x0012, 2, s.length, datumAt),
    u32(0),
    s,
    s,
  ]);
}

/** A JPEG marker segment (the length counts itself). */
const segment = (marker: number, body: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);

/** Splices segments right after a JPEG's SOI. */
export const spliceJpeg = (jpeg: Buffer, segments: Buffer[]) =>
  Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);

const xmp = (text: string) =>
  Buffer.from(
    `http://ns.adobe.com/xap/1.0/\0<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${text}</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    'latin1',
  );

function iptc(text: string): Buffer {
  const t = Buffer.from(text, 'latin1');
  const dataset = Buffer.concat([Buffer.from([0x1c, 0x02, 0x78]), u16(t.length), t]); // 2:120 caption
  const padded = dataset.length % 2 === 0 ? dataset : Buffer.concat([dataset, Buffer.from([0])]);
  return Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM', 'latin1'),
    u16(0x0404),
    u16(0),
    u32(dataset.length),
    padded,
  ]);
}

/** A 600 × 400 JPEG with the canary in EXIF (IFD0 and GPS), XMP, APP13 (IPTC) and a COM segment. */
export async function canaryJpeg(): Promise<Buffer> {
  const base = await noise(600, 400).jpeg().toBuffer();
  return spliceJpeg(base, [
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(CANARY)])),
    segment(0xe1, xmp(CANARY)),
    segment(0xed, iptc(CANARY)),
    segment(0xfe, Buffer.from(CANARY, 'latin1')),
  ]);
}

/** A JPEG with an embedded ICC profile (Display P3). */
export const iccJpeg = () => noise(600, 400).jpeg().withIccProfile('p3').toBuffer();

/** A 600 × 400 JPEG whose EXIF orientation (6) turns it into 400 × 600. */
export const rotatedJpeg = () => noise(600, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();

/** A JPEG whose COM segment and trailing bytes are an HTML page. */
export async function polyglotJpeg(): Promise<Buffer> {
  const html = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'latin1');
  return Buffer.concat([spliceJpeg(await noise(300, 200).jpeg().toBuffer(), [segment(0xfe, html)]), html]);
}

/** The first half of a real JPEG. */
export async function truncatedJpeg(): Promise<Buffer> {
  const whole = await noise(600, 400).jpeg().toBuffer();
  return whole.subarray(0, Math.floor(whole.length / 2));
}

const chunk = (type: string, data: Buffer) => {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), td, u32(crc32(td))]);
};

/** Splices chunks right after a PNG's IHDR (signature 8 bytes, IHDR 25). */
const splicePng = (png: Buffer, chunks: Buffer[]) => Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);

/** A 600 × 400 PNG with the canary in tEXt, iTXt and eXIf chunks. */
export async function canaryPng(): Promise<Buffer> {
  const base = await noise(600, 400).png().toBuffer();
  return splicePng(base, [
    chunk('tEXt', Buffer.from(`Comment\0${CANARY}`, 'latin1')),
    chunk('iTXt', Buffer.from(`Description\0\0\0\0\0${CANARY}`, 'latin1')),
    chunk('eXIf', exifTiff(CANARY)),
  ]);
}

/** A 30,000 × 30,000 PNG of a few hundred bytes: a real IHDR, a stub IDAT, IEND. */
export function bombPng(): Buffer {
  const ihdr = Buffer.concat([u32(30_000), u32(30_000), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(256))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const plainPng = () => noise(600, 400).png().toBuffer();
export const tiff = () => noise(64, 48).tiff().toBuffer();
export const gif = () => noise(64, 48).gif().toBuffer();
export const avif = () => noise(64, 48).avif().toBuffer();
export const svg = () =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48"/></svg>');
