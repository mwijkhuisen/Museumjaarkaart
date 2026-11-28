import { createHash, timingSafeEqual } from 'node:crypto';
import type { PhotoType, UploadCreate, UploadStatus } from '@mjk/contracts';
import { fileTypeFromBuffer } from 'file-type';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { enqueueIn } from '../worker/queue.ts';
import { chunkLength } from './chunks.ts';
import { openUpload, removeUpload } from './files.ts';
import {
  CHUNK_BYTES,
  MEMBER_MAX_BYTES,
  OPEN_UPLOAD_BYTES_SITE,
  OPEN_UPLOADS_PER_MEMBER,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  PHOTOS_PER_REVIEW,
} from './limits.ts';
import { MEDIA_PROCESS_JOB } from './types.ts';

// The upload service (A§12, A§14; P3b plan §2 "Upload API"). The route checks the session, the body shape, the
// consents and the disk guard; this module runs every quota inside one transaction before any byte is stored,
// and the `complete` checks before the file reaches the worker. Every state change is guarded by the state it
// leaves (`WHERE state = …`), so a concurrent delete or purge can never be undone. Refusals are typed results;
// the route maps them to A§14's answers.

/** States whose photo still counts against the per-museum and per-member limits. */
const LIVE_STATES = ['uploading', 'quarantined', 'processing', 'pending_review', 'approved'] as const;

export type CreateRefusal =
  | 'type' // 415: not one of the three types
  | 'size' // 422 ["size"]: over 25 MiB, or past the member's 1 GiB
  | 'museum_id' // 422: not a visible museum
  | 'review_id' // 422: not the member's own visible review of that museum
  | 'photos' // 422: already 10 photos of this museum (one review per museum and member)
  | 'open' // 429: 3 uploads already open
  | 'site_full'; // 503: 2 GiB declared across all open uploads

export type Created = { id: string; chunkCount: number };

const isPhotoType = (type: string): type is PhotoType => (PHOTO_TYPES as readonly string[]).includes(type);

/**
 * The quota checks and the new `uploading` row, on the caller's transaction (which then adds the rate hit and the
 * content-IP row). One global advisory lock serialises every create, so two parallel creates cannot both pass a
 * count. ponytail: one global lock; per-member locks if creates ever contend.
 */
export async function createUpload(
  trx: Db,
  userId: string,
  body: UploadCreate,
): Promise<{ ok: true; id: string; chunkCount: number } | { ok: false; reason: CreateRefusal }> {
  if (!isPhotoType(body.type)) return { ok: false, reason: 'type' };
  if (body.size > PHOTO_MAX_BYTES) return { ok: false, reason: 'size' };
  await sql`SELECT pg_advisory_xact_lock(hashtext('mjk_upload_create'))`.execute(trx);

  const museum = await trx.selectFrom('pub_museum').select('id').where('id', '=', body.museum_id).executeTakeFirst();
  if (museum === undefined) return { ok: false, reason: 'museum_id' };
  if (body.review_id !== undefined) {
    const review = await trx
      .selectFrom('review')
      .select('id')
      .where('id', '=', body.review_id)
      .where('user_id', '=', userId)
      .where('museum_id', '=', body.museum_id)
      .where('state', '=', 'visible')
      .executeTakeFirst();
    if (review === undefined) return { ok: false, reason: 'review_id' };
  }

  const mine = await trx
    .selectFrom('media')
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere('museum_id', '=', body.museum_id).as('of_museum'),
      eb.fn.coalesce(eb.fn.sum<string>('declared_size'), sql<string>`0`).as('bytes'),
      eb.fn.countAll<string>().filterWhere('state', '=', 'uploading').as('open'),
    ])
    .where('user_id', '=', userId)
    .where('state', 'in', LIVE_STATES)
    .executeTakeFirstOrThrow();
  if (Number(mine.of_museum) >= PHOTOS_PER_REVIEW) return { ok: false, reason: 'photos' };
  if (Number(mine.bytes) + body.size > MEMBER_MAX_BYTES) return { ok: false, reason: 'size' };
  if (Number(mine.open) >= OPEN_UPLOADS_PER_MEMBER) return { ok: false, reason: 'open' };

  const site = await trx
    .selectFrom('media')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('declared_size'), sql<string>`0`).as('bytes'))
    .where('state', '=', 'uploading')
    .executeTakeFirstOrThrow();
  if (Number(site.bytes) + body.size > OPEN_UPLOAD_BYTES_SITE) return { ok: false, reason: 'site_full' };

  const chunkCount = Math.ceil(body.size / CHUNK_BYTES);
  const row = await trx
    .insertInto('media')
    .values({
      user_id: userId,
      museum_id: body.museum_id,
      review_id: body.review_id ?? null,
      type: body.type,
      declared_size: body.size,
      chunk_count: chunkCount,
      consents_at: sql<Date>`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { ok: true, id: row.id, chunkCount };
}

/** The member's own upload, or undefined (another member's is a 404, never a 403). */
export function ownUpload(db: Db, userId: string, id: string) {
  return db
    .selectFrom('media')
    .select(['id', 'user_id', 'state', 'type', 'declared_size', 'chunk_count', 'error_code', 'width', 'height'])
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export type OwnUpload = NonNullable<Awaited<ReturnType<typeof ownUpload>>>;

/** `GET /uploads/:id`: the state, its code and, once approved, the variant keys. */
export async function uploadStatus(db: Db, upload: OwnUpload): Promise<UploadStatus> {
  const keys =
    upload.state === 'approved'
      ? (
          await db
            .selectFrom('media_variant')
            .select('object_key')
            .where('media_id', '=', upload.id)
            .orderBy('format')
            .orderBy('width')
            .execute()
        ).map((v) => v.object_key)
      : [];
  return { id: upload.id, state: upload.state as UploadStatus['state'], error_code: upload.error_code, keys };
}

/** Marks an upload `failed` with a fixed code (only from `uploading`) and removes its files. */
export async function failUpload(db: Db, root: string, id: string, code: string): Promise<void> {
  await db
    .updateTable('media')
    .set({ state: 'failed', error_code: code })
    .where('id', '=', id)
    .where('state', '=', 'uploading')
    .execute();
  await removeUpload(root, id);
}

/** The expected length of chunk `n`, or undefined when `n` is out of range. */
export function expectedChunk(upload: OwnUpload, n: number): number | undefined {
  if (!Number.isInteger(n) || n < 0 || n >= upload.chunk_count) return undefined;
  return chunkLength(upload.declared_size, upload.chunk_count, n);
}

export type CompleteRefusal =
  | 'chunks' // 422: a chunk is missing (the upload stays open)
  | 'size' // 422: the file is not the declared size (failed)
  | 'sha256' // 422: the whole file's hash differs (failed)
  | 'type' // 415: the magic bytes are not the declared type (failed, no job)
  | 'blocked' // 422: the hash is in blocked_hash (failed as the neutral `upload_refused`, audit-logged)
  | 'gone'; // 409: the upload left `uploading` meanwhile (an abort or the purge)

/** Enough of the head for file-type to tell JPEG, PNG (and APNG's acTL before the first IDAT) and WebP apart. */
const HEAD_BYTES = 64 * 1024;

/** The file's size, sha256 and type by magic bytes, read through one handle of our own (never re-opened). */
async function inspect(root: string, id: string): Promise<{ size: number; sha256: Buffer; mime: string | undefined }> {
  const fh = await openUpload(root, id, 'read');
  try {
    const { size } = await fh.stat();
    const hash = createHash('sha256');
    for await (const buf of fh.createReadStream({ autoClose: false, start: 0 })) hash.update(buf as Buffer);
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const mime = (await fileTypeFromBuffer(head.subarray(0, bytesRead)))?.mime;
    return { size, sha256: hash.digest(), mime };
  } finally {
    await fh.close();
  }
}

/**
 * The `complete` checks (A§12): every chunk, the size, the whole-file sha256 the browser computed, the magic bytes
 * (file-type: one of the three and the declared type, so an animated PNG, `image/apng`, is refused), the blocked
 * hashes; then `quarantined` and the `media_process` job in one transaction. Every refusal but a missing chunk
 * fails the upload and removes its file, so nothing reaches the worker.
 */
export async function completeUpload(
  db: Db,
  root: string,
  upload: OwnUpload,
  claimed: string,
): Promise<{ ok: true } | { ok: false; reason: CompleteRefusal }> {
  const received = await db
    .selectFrom('media_chunk')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('media_id', '=', upload.id)
    .executeTakeFirstOrThrow();
  if (Number(received.n) !== upload.chunk_count) return { ok: false, reason: 'chunks' };

  const file = await inspect(root, upload.id);
  const refuse = async (reason: CompleteRefusal, code: string) => {
    await failUpload(db, root, upload.id, code);
    return { ok: false as const, reason };
  };
  if (file.size !== upload.declared_size) return refuse('size', 'upload_size_mismatch');
  const want = Buffer.from(claimed, 'hex');
  if (want.length !== 32 || !timingSafeEqual(want, file.sha256)) return refuse('sha256', 'upload_hash_mismatch');
  if (file.mime === undefined || file.mime !== upload.type) return refuse('type', 'upload_type_mismatch');

  const blocked = await db
    .selectFrom('blocked_hash')
    .select('sha256')
    .where('sha256', '=', file.sha256)
    .executeTakeFirst();
  if (blocked !== undefined) {
    // The row names the member, so it outlives the failed photo's purge after 24 h; the media id is detail. The
    // uploader's status shows only the neutral `upload_refused`, never that the hash is on the list (P3b review).
    await db
      .insertInto('audit_log')
      .values({
        actor_kind: 'system',
        actor_id: null,
        action: 'media.blocked',
        target_kind: 'user',
        target_id: upload.user_id,
        detail: JSON.stringify({ media_id: upload.id }),
      })
      .execute();
    return refuse('blocked', 'upload_refused');
  }

  const moved = await db.transaction().execute(async (trx) => {
    const r = await trx
      .updateTable('media')
      .set({ state: 'quarantined', sha256: file.sha256 })
      .where('id', '=', upload.id)
      .where('state', '=', 'uploading')
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return false;
    await trx.deleteFrom('media_chunk').where('media_id', '=', upload.id).execute();
    await enqueueIn(trx, MEDIA_PROCESS_JOB, { media_id: upload.id }, {});
    return true;
  });
  // The row left `uploading` meanwhile (an abort or the purge took it): its files are someone else's to remove.
  if (!moved) return { ok: false, reason: 'gone' };
  return { ok: true };
}
