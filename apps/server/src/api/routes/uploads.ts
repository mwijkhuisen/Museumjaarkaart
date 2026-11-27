import {
  CHUNK_BYTES,
  ChunkIndexParam,
  EmptyQuery,
  MediaIdParam,
  UploadComplete,
  UploadCreate,
  UploadCreated,
  UploadStatus,
} from '@mjk/contracts';
import type { Context } from 'hono';
import { BUCKETS, enforce, hit, userKey } from '../../auth/limiter.ts';
import { writeChunk } from '../../media/chunks.ts';
import { diskAllowsUploads } from '../../media/disk.ts';
import { createUploadFile, openUpload, removeUpload, withUploadLock } from '../../media/files.ts';
import { GUARD_DIR, QUARANTINE_DIR } from '../../media/limits.ts';
import {
  type CompleteRefusal,
  type CreateRefusal,
  completeUpload,
  createUpload,
  expectedChunk,
  ownUpload,
  uploadStatus,
} from '../../media/uploads.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { clientOr429 } from '../middleware/client-address.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { requireMember, requirePoster } from '../middleware/session.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The chunked upload (A§12, A§14; P3b plan §2 "Upload API"), the security boundary of the photo pipeline:
//   POST /uploads → PUT /uploads/:id/chunks/:n (8 MiB, application/octet-stream) → POST /uploads/:id/complete.
// Every quota, consent and disk check runs before a byte is stored; a chunk's index and exact length are checked
// before it is written, and it is written only inside its own range of a file that never passes the declared size.
// Every query is keyed on the session's user, so another member's upload is a 404, never a 403. Nothing here is
// logged but fixed codes (invariant 8): no file name, size, hash, id or address.

/** A retry hint for "3 uploads already open": a chunked upload of a photo takes seconds to minutes. */
const OPEN_RETRY_S = 60;

const mediaId = (raw: string | undefined): string => {
  const parsed = MediaIdParam.safeParse(raw);
  if (!parsed.success) throw new ApiError('not_found');
  return parsed.data;
};

const createError = (reason: CreateRefusal): ApiError => {
  switch (reason) {
    case 'type':
      return new ApiError('unsupported_type');
    case 'open':
      return new ApiError('rate_limited', undefined, OPEN_RETRY_S);
    case 'site_full':
      return new ApiError('unavailable');
    default:
      return new ApiError('invalid', [reason]);
  }
};

const completeError = (reason: CompleteRefusal): ApiError => {
  switch (reason) {
    case 'type':
      return new ApiError('unsupported_type');
    case 'gone':
      return new ApiError('conflict');
    case 'blocked':
      return new ApiError('invalid', ['file']);
    default:
      return new ApiError('invalid', [reason]);
  }
};

/** Runs `fn` under the upload's in-process lock, or answers 409 while another request works on it. */
async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const r = await withUploadLock(id, fn);
  if (r === undefined) throw new ApiError('conflict');
  return r.value;
}

const noContent = (c: Context<ApiEnv>) => {
  c.header('Cache-Control', CACHE_PRIVATE);
  return c.body(null, 204);
};

export function mountUploads(v1: ApiApp, deps: ApiDeps): void {
  const { db, logger, keys } = deps;
  if (keys === undefined) throw new Error('uploads_need_keys');
  const root = deps.quarantineDir ?? QUARANTINE_DIR;
  const guardDir = deps.guardDir ?? GUARD_DIR;

  v1.post('/uploads', async (c) => {
    const userId = requirePoster(c).user.id;
    parseQuery(c, EmptyQuery);
    const body = await readJson(c, UploadCreate);
    const { own_photo, no_people, no_artwork } = body.consents;
    if (!(own_photo && no_people && no_artwork)) throw new ApiError('invalid', ['consents']);
    const client = clientOr429(c, logger, BUCKETS.photoUserDay);
    if (!(await diskAllowsUploads(guardDir))) {
      logger.warn({}, 'upload_disk_guard');
      throw new ApiError('unavailable');
    }
    let made: string | undefined;
    try {
      const created = await db.transaction().execute(async (trx) => {
        const r = await createUpload(trx, userId, body);
        if (!r.ok) throw createError(r.reason);
        // The rate hit last, after every check, so a refused create counts for nothing (the P3a pattern).
        enforce(logger, BUCKETS.photoUserDay, await hit(trx, BUCKETS.photoUserDay, userKey(keys, 'photo', userId)));
        await trx
          .insertInto('content_ip_log')
          .values({ user_id: userId, target_kind: 'media', target_id: r.id, ip: client.address })
          .execute();
        made = r.id;
        await createUploadFile(root, r.id);
        return r;
      });
      return sendJson(
        c,
        UploadCreated,
        { id: created.id, chunk_size: CHUNK_BYTES, chunk_count: created.chunkCount },
        CACHE_PRIVATE,
        201,
      );
    } catch (err) {
      // The transaction rolled back after the files were made (a failed commit): nothing may stay behind.
      if (made !== undefined) await removeUpload(root, made);
      throw err;
    }
  });

  v1.put('/uploads/:id/chunks/:n', async (c) => {
    const userId = requireMember(c).user.id;
    const id = mediaId(c.req.param('id'));
    const n = ChunkIndexParam.safeParse(c.req.param('n'));
    if (!n.success) throw new ApiError('invalid', ['n']);
    parseQuery(c, EmptyQuery);
    // jsonOnly let only application/octet-stream through on this path; the body cap kept it under 8 MiB and
    // refused a body of unknown length, so a body here always has a decimal Content-Length.
    const declared = c.req.header('content-length');
    return locked(id, async () => {
      const upload = await ownUpload(db, userId, id);
      if (upload === undefined) throw new ApiError('not_found');
      if (upload.state !== 'uploading') throw new ApiError('conflict');
      const index = Number(n.data);
      const expected = expectedChunk(upload, index);
      if (expected === undefined) throw new ApiError('invalid', ['n']);
      if (declared === undefined || Number(declared.trim()) !== expected) throw new ApiError('invalid', ['length']);
      // A re-sent chunk is unreceived while it is written, so a write that breaks off leaves no stale row.
      const prev = await db
        .deleteFrom('media_chunk')
        .where('media_id', '=', upload.id)
        .where('n', '=', index)
        .returning('sha256')
        .executeTakeFirst();
      const fh = await openUpload(root, upload.id, 'write');
      let written: Awaited<ReturnType<typeof writeChunk>>;
      try {
        written = await writeChunk(fh, c.req.raw.body, index, expected);
      } finally {
        await fh.close();
      }
      if (!written.ok) {
        c.set('bodyMismatch', true);
        throw new ApiError('invalid', ['body']);
      }
      // A re-send with other bytes than the chunk had: refused, and the chunk stays unreceived (its range now
      // holds the new bytes), so the browser sends it again; an identical re-send is accepted.
      if (prev !== undefined && !Buffer.from(prev.sha256).equals(written.sha256))
        throw new ApiError('invalid', ['chunk']);
      await db.insertInto('media_chunk').values({ media_id: upload.id, n: index, sha256: written.sha256 }).execute();
      return noContent(c);
    });
  });

  v1.post('/uploads/:id/complete', async (c) => {
    const userId = requireMember(c).user.id;
    const id = mediaId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    const body = await readJson(c, UploadComplete);
    return locked(id, async () => {
      const upload = await ownUpload(db, userId, id);
      if (upload === undefined) throw new ApiError('not_found');
      if (upload.state !== 'uploading') throw new ApiError('conflict');
      const done = await completeUpload(db, root, upload, body.sha256);
      if (!done.ok) {
        if (done.reason === 'blocked') logger.warn({}, 'upload_blocked_hash');
        throw completeError(done.reason);
      }
      return sendJson(
        c,
        UploadStatus,
        { id: upload.id, state: 'quarantined', error_code: null, keys: [] },
        CACHE_PRIVATE,
        202,
      );
    });
  });

  v1.get('/uploads/:id', async (c) => {
    const userId = requireMember(c).user.id;
    const id = mediaId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    const upload = await ownUpload(db, userId, id);
    if (upload === undefined) throw new ApiError('not_found');
    return sendJson(c, UploadStatus, await uploadStatus(db, upload), CACHE_PRIVATE);
  });

  // Aborts an upload that is still `uploading`; a finished photo is deleted through DELETE /media/:id.
  v1.delete('/uploads/:id', async (c) => {
    const userId = requireMember(c).user.id;
    const id = mediaId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    return locked(id, async () => {
      const gone = await db
        .deleteFrom('media')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('state', '=', 'uploading')
        .returning('id')
        .executeTakeFirst();
      if (gone === undefined) {
        if ((await ownUpload(db, userId, id)) === undefined) throw new ApiError('not_found');
        throw new ApiError('conflict');
      }
      await removeUpload(root, gone.id);
      return noContent(c);
    });
  });
}
