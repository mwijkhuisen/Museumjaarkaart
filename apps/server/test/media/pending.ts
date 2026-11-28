import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VariantFormat } from '@mjk/contracts';
import sharp from 'sharp';
import { R2Client } from '../../src/media/r2.ts';
import type { PassportDb } from '../passport/fixtures.ts';
import { jpeg, sha256Hex } from './fixtures.ts';

// A processed photo as the `media` package leaves it (WP3 is built in parallel, so these tests do not need it):
// the owner's rows (media in `pending_review`, its variants) and the files in a temp quarantine
// (`<id>/upload`, `<id>/v/<width>.<format>`). The variant bytes are real AVIF and WebP of the photo's 4:3 size,
// for the container check.

export const WIDTHS = [400, 1200] as const;
export const FORMATS: readonly VariantFormat[] = ['avif', 'webp'];

const images = new Map<string, Buffer>();
async function variantImage(format: VariantFormat, width: number): Promise<Buffer> {
  const name = `${width}.${format}`;
  let bytes = images.get(name);
  if (bytes === undefined) {
    const img = sharp({ create: { width, height: (width * 3) / 4, channels: 3, background: '#336699' } });
    bytes = await (format === 'avif' ? img.avif() : img.webp()).toBuffer();
    images.set(name, bytes);
  }
  return bytes;
}

export type Pending = {
  id: string;
  userId: string;
  handle: string;
  reviewId: string | null;
  publicKey: string;
  keys: string[];
  original: Buffer;
};

/** A member (trusted or not) with a review, and a `pending_review` photo attached to it (or not). */
export async function pendingPhoto(
  p: PassportDb,
  quarantine: string,
  o: { trusted?: boolean; attached?: boolean; state?: string } = {},
): Promise<Pending> {
  const u = await p.newMember();
  if (o.trusted ?? true) await p.owner.query('UPDATE app_user SET trusted_at = now() WHERE id = $1', [u.id]);
  const museum = await p.visible(0);
  const visit = await p.addVisit(u.id, museum.id);
  const review = (
    await p.owner.query<{ id: string }>(
      'INSERT INTO review (user_id, museum_id, visit_id, rating) VALUES ($1, $2, $3, 4) RETURNING id',
      [u.id, museum.id, visit],
    )
  ).rows[0]?.id as string;
  const original = await jpeg();
  const publicKey = randomBytes(16).toString('hex');
  const reviewId = (o.attached ?? true) ? review : null;
  const id = (
    await p.owner.query<{ id: string }>(
      `INSERT INTO media (user_id, museum_id, review_id, type, state, declared_size, chunk_count, sha256, width,
         height, public_key, consents_at)
       VALUES ($1, $2, $3, 'image/jpeg', $4, $5, 1, decode($6, 'hex'), 1200, 900, $7, now()) RETURNING id`,
      [u.id, museum.id, reviewId, o.state ?? 'pending_review', original.length, sha256Hex(original), publicKey],
    )
  ).rows[0]?.id as string;
  await mkdir(join(quarantine, id, 'v'), { recursive: true, mode: 0o700 });
  await writeFile(join(quarantine, id, 'upload'), original);
  const keys: string[] = [];
  for (const format of FORMATS) {
    for (const width of WIDTHS) {
      const key = `p/${publicKey}/${width}.${format}`;
      keys.push(key);
      await p.owner.query(
        'INSERT INTO media_variant (media_id, format, width, object_key, bytes) VALUES ($1, $2, $3, $4, $5)',
        [id, format, width, key, (await variantImage(format, width)).length],
      );
      await writeFile(join(quarantine, id, 'v', `${width}.${format}`), await variantImage(format, width));
    }
  }
  return { id, userId: u.id, handle: u.handle, reviewId, publicKey, keys, original };
}

/** The MinIO stand-in (A§18): empty locally (the tests skip), set in CI (they fail without it). */
export const minioUrl = process.env.MJK_TEST_MINIO_URL ?? '';

/** A client on a fresh bucket of the stand-in, which it creates. */
export async function minioBucket(prefix: string): Promise<R2Client> {
  const accessKeyId = process.env.MJK_TEST_MINIO_ACCESS_KEY ?? '';
  const secretAccessKey = process.env.MJK_TEST_MINIO_SECRET_KEY ?? '';
  if (accessKeyId === '' || secretAccessKey === '')
    throw new Error('MJK_TEST_MINIO_ACCESS_KEY and _SECRET_KEY are needed');
  const c = new R2Client({
    endpoint: minioUrl,
    bucket: `${prefix}-${process.pid}-${randomBytes(3).toString('hex')}`,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    timeoutMs: 30_000,
  });
  if ((await c.send({ method: 'PUT' })).status !== 200) throw new Error('CreateBucket failed');
  return c;
}

/** Every key in the bucket (ListObjectsV2; the client has no list of its own). */
export async function listKeys(c: R2Client): Promise<string[]> {
  const res = await c.send({ method: 'GET', query: { 'list-type': '2' }, maxBytes: 1024 * 1024 });
  if (res.status !== 200) throw new Error(`ListObjectsV2: ${res.status}`);
  const xml = new TextDecoder().decode(res.body);
  if (xml.includes('<IsTruncated>true')) throw new Error('ListObjectsV2: truncated');
  return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1] as string).sort();
}

/** Empties and deletes the bucket. */
export async function dropBucket(c: R2Client): Promise<void> {
  for (const key of await listKeys(c)) await c.delete(key);
  await c.send({ method: 'DELETE' });
}
