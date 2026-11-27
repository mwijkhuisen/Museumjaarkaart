import { constants } from 'node:fs';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VARIANT_FORMATS, type VariantFormat } from '@mjk/contracts';
import { fileTypeFromBuffer } from 'file-type';
import { sql } from 'kysely';
import { z } from 'zod';
import { ORIGINALS_DIR } from '../backup/plan.ts';
import type { Db } from '../db/kysely.ts';
import { IMMUTABLE } from '../tiles/publish.ts';
import { JobError, type JobHandler } from '../worker/types.ts';
import { removeUpload } from './files.ts';
import { QUARANTINE_DIR } from './limits.ts';
import { MEDIA_SECRET_PATH, PUT_MAX_BYTES, R2Client, readR2Config } from './r2.ts';
import { VARIANT_CONTENT_TYPE, variantKey } from './types.ts';

// The `media_publish` job (A§12, P3b WP4), as mjk_worker: a photo in `pending_review`, attached to a review, whose
// owner is trusted (P3c adds a moderator's approval), gets its variants on R2 and its original in
// /srv/mjk/originals, then turns `approved`. Nothing stays on R2 or in originals for a photo that is not approved:
// a failure part-way and an approval that no longer holds (trust revoked, the photo moved) delete what this run
// put. Every step is idempotent (a PUT overwrites, the original is written to a temp name and renamed).
//
// The quarantine is shared with the api, so nothing in it is trusted: each directory is opened O_NOFOLLOW and each
// file through that directory's descriptor (`/proc/self/fd/<fd>/<name>`) with O_NOFOLLOW (O_NONBLOCK: a FIFO
// never blocks the open), fstat'd (regular, the expected size) and read once; a variant's magic bytes must be its
// format. So no link or planted file of the worker's can reach the public bucket.

type Env = Readonly<Record<string, string | undefined>>;

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Payload = z.strictObject({ media_id: z.string().regex(MEDIA_ID) });

/** The `{media_id}` payload of the photo jobs; anything else fails the job at once. */
export function mediaIdOf(payload: unknown): string {
  const p = Payload.safeParse(payload);
  if (!p.success) throw new JobError('media_bad_payload', { retry: false });
  return p.data.media_id;
}

/** A cleanup after a failure or an abort: short, and without the job's signal. */
const CLEANUP_TIMEOUT_MS = 30_000;

export type MediaJobDeps = {
  db: Db;
  env: Env;
  /** Test seams. */
  quarantineDir?: string;
  originalsDir?: string;
  r2?: R2Client;
  secretPath?: string;
};

/** Run time, not worker start (as the tiles jobs): a worker without the MJK_R2_* values still runs the rest. */
export const r2Of = (d: MediaJobDeps): R2Client =>
  d.r2 ?? new R2Client(readR2Config(d.env, d.secretPath ?? MEDIA_SECRET_PATH));

/** Removes `originals/<id>` and a leftover `<id>.tmp`. */
export async function removeOriginal(dir: string, id: string): Promise<void> {
  await rm(join(dir, `${id}.tmp`), { force: true });
  await rm(join(dir, id), { force: true });
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;

/** A regular file of exactly `size` bytes, read once; undefined for anything else (missing, a link, a FIFO, resized). */
async function readExact(path: string, size: number): Promise<Buffer | undefined> {
  const fh = await open(path, FILE_FLAGS).catch(() => undefined);
  if (fh === undefined) return undefined;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== size) return undefined;
    // One byte more than expected tells a file that grew since the fstat.
    const buf = Buffer.alloc(size + 1);
    let done = 0;
    while (done <= size) {
      const { bytesRead } = await fh.read(buf, done, size + 1 - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return done === size ? buf.subarray(0, size) : undefined;
  } finally {
    await fh.close();
  }
}

async function withDir<T>(path: string, fn: (dir: FileHandle) => Promise<T>): Promise<T | undefined> {
  const dir = await open(path, DIR_FLAGS).catch(() => undefined);
  if (dir === undefined) return undefined;
  try {
    return await fn(dir);
  } finally {
    await dir.close();
  }
}

type VariantRow = { format: string; width: number; object_key: string; bytes: number };
type Files = { original: Buffer; variants: { key: string; format: VariantFormat; bytes: Buffer }[] };

/** The original and every variant from `quarantine/<id>/`, checked; a JobError (no retry) when one is not right. */
async function readFiles(
  quarantineDir: string,
  id: string,
  publicKey: string,
  declaredSize: number,
  rows: readonly VariantRow[],
): Promise<Files> {
  const files = await withDir(join(quarantineDir, id), async (idDir) => {
    const original = await readExact(at(idDir, 'upload'), declaredSize);
    if (original === undefined) throw new JobError('media_original_invalid', { retry: false });
    const variants = await withDir(at(idDir, 'v'), async (vDir) => {
      const out: Files['variants'] = [];
      for (const r of rows) {
        const format = VARIANT_FORMATS.find((f) => f === r.format);
        if (
          format === undefined ||
          r.object_key !== variantKey(publicKey, format, r.width) ||
          r.bytes > PUT_MAX_BYTES
        ) {
          throw new JobError('media_variant_invalid', { retry: false });
        }
        const bytes = await readExact(at(vDir, `${r.width}.${format}`), r.bytes);
        if (bytes === undefined || (await fileTypeFromBuffer(bytes))?.ext !== format) {
          throw new JobError('media_variant_invalid', { retry: false });
        }
        out.push({ key: r.object_key, format, bytes });
      }
      return out;
    });
    if (variants === undefined) throw new JobError('media_variant_invalid', { retry: false });
    return { original, variants };
  });
  if (files === undefined) throw new JobError('media_original_invalid', { retry: false });
  return files;
}

/** `originals/<id>` by a temp file (O_EXCL, no link), fsync, rename and a directory fsync. Same mount only. */
async function writeOriginal(dir: string, id: string, bytes: Buffer): Promise<void> {
  const tmp = join(dir, `${id}.tmp`);
  await rm(tmp, { force: true });
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, id));
  const d = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

export type PublishDeps = MediaJobDeps & {
  /** Test seam: runs after the PUTs and the original, before the approving UPDATE. */
  beforeApprove?: () => Promise<void>;
};

/** The handler of `media_publish` jobs. */
export function mediaPublishJob(d: PublishDeps): JobHandler {
  return async (payload, { signal }) => {
    const id = mediaIdOf(payload);
    const { db } = d;
    const quarantineDir = d.quarantineDir ?? QUARANTINE_DIR;
    const originalsDir = d.originalsDir ?? ORIGINALS_DIR;

    const m = await db
      .selectFrom('media as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select(['m.state', 'm.review_id', 'm.public_key', 'm.declared_size', 'u.trusted_at'])
      .where('m.id', '=', id)
      .executeTakeFirst();
    // Not (or no longer) publishable: a no-op. P3c's moderator approval joins the trust check here.
    if (m === undefined || m.state !== 'pending_review' || m.review_id === null || m.trusted_at === null) return;
    if (m.public_key === null) throw new JobError('media_variant_invalid', { retry: false });

    const rows = await db
      .selectFrom('media_variant')
      .select(['format', 'width', 'object_key', 'bytes'])
      .where('media_id', '=', id)
      .orderBy('format')
      .orderBy('width')
      .execute();
    if (rows.length === 0) throw new JobError('media_variant_invalid', { retry: false });
    const files = await readFiles(quarantineDir, id, m.public_key, m.declared_size, rows);

    const r2 = r2Of(d);
    const put: string[] = [];
    let wroteOriginal = false;
    const undo = async () => {
      for (const key of put) {
        await r2.send({ method: 'DELETE', key, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => {});
      }
      if (wroteOriginal) await removeOriginal(originalsDir, id).catch(() => {});
    };

    try {
      for (const v of files.variants) {
        put.push(v.key);
        await r2.put(v.key, v.bytes, { contentType: VARIANT_CONTENT_TYPE[v.format], cacheControl: IMMUTABLE, signal });
      }
      wroteOriginal = true;
      await writeOriginal(originalsDir, id, files.original);
      await d.beforeApprove?.();
    } catch (err) {
      await undo();
      throw err;
    }

    const approved = await db
      .updateTable('media')
      .set({ state: 'approved', decided_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('state', '=', 'pending_review')
      .where('review_id', 'is not', null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('app_user as u')
            .select(sql`1`.as('one'))
            .whereRef('u.id', '=', 'media.user_id')
            .where('u.trusted_at', 'is not', null),
        ),
      )
      .executeTakeFirst();
    if (approved.numUpdatedRows === 0n) {
      // A run that approved it meanwhile owns these objects; otherwise nothing may stay.
      const now = await db.selectFrom('media').select('state').where('id', '=', id).executeTakeFirst();
      if (now?.state !== 'approved') await undo();
      return;
    }
    await removeUpload(quarantineDir, id);
  };
}
