import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import type { Db } from '../../db/kysely.ts';
import type { Logger } from '../../lib/log.ts';
import { createDecode } from '../../media/handoff.ts';
import { QUARANTINE_DIR } from '../../media/limits.ts';
import { type MediaJobDeps, r2Of } from '../../media/publish.ts';
import { removeTree } from '../../media/remove-tree.ts';
import { type Decode, type SourceFormat, VARIANT_CONTENT_TYPE } from '../../media/types.ts';
import { IMMUTABLE } from '../../tiles/publish.ts';
import { JobError, type JobHandler } from '../../worker/types.ts';
import { fetchBytes, fetchJson, type HttpDeps } from '../sources/http.ts';
import { imageInfoUrl, parseImageInfo } from './api.ts';
import {
  COMMONS_MAX_BYTES,
  commitRow,
  deleteKeys,
  imageKeys,
  judge,
  newPublicKey,
  requestError,
  writeSkipped,
} from './store.ts';

// The `commons_image {museum_id}` job (ADR-0018, A§12), as mjk_worker, one at a time. It reads the museum's
// Commons file again, judges its licence and credit, downloads the 1920 px rendering from upload.wikimedia.org
// only, has the `media` role re-encode it, puts the variants on R2 under a new random key and only then points
// the row at them and deletes the previous image's objects. Everything from Commons is data: the credit is
// reduced to plain text, and the bytes are sniffed and decoded like a member's upload.

const Payload = z.strictObject({ museum_id: z.uuid() });
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const FORMAT: Readonly<Record<string, SourceFormat>> = { jpg: 'jpeg', png: 'png', webp: 'webp' };

export type CommonsDeps = MediaJobDeps & {
  logger?: Logger;
  decode?: Decode;
  /** Test seams for the request (fetch, sleep, timeouts); the contact comes from MJK_SYNC_CONTACT. */
  http?: HttpDeps;
};

export const httpOf = (d: Pick<CommonsDeps, 'env' | 'http'>): HttpDeps => ({
  ...(d.env.MJK_SYNC_CONTACT === undefined ? {} : { contact: d.env.MJK_SYNC_CONTACT }),
  ...d.http,
});

/** The hidden museum's image: its objects go (R2 is the worker's), the row stays hidden with no keys. */
async function dropHidden(db: Db, d: CommonsDeps, museumId: string, signal: AbortSignal): Promise<void> {
  const row = await db
    .selectFrom('museum_image')
    .select(['public_key', 'widths'])
    .where('museum_id', '=', museumId)
    .executeTakeFirst();
  if (row?.public_key != null) await deleteKeys(r2Of(d), imageKeys(row.public_key, row.widths ?? []), signal);
  // A row that is hidden before it was ever fetched has no skip_code yet; `unhide` needs one.
  await db
    .updateTable('museum_image')
    .set({ public_key: null, widths: null, width: null, height: null, skip_code: 'commons_hidden' })
    .where('museum_id', '=', museumId)
    .where('state', '=', 'hidden')
    .execute();
}

export function commonsImageJob(d: CommonsDeps): JobHandler {
  const { db } = d;
  const root = d.quarantineDir ?? QUARANTINE_DIR;
  const http = httpOf(d);
  return async (payload, { signal }) => {
    const p = Payload.safeParse(payload);
    if (!p.success) throw new JobError('commons_bad_payload', { retry: false });
    const id = p.data.museum_id;

    const m = await db.selectFrom('museum').select('commons_file').where('id', '=', id).executeTakeFirst();
    const row = await db.selectFrom('museum_image').selectAll().where('museum_id', '=', id).executeTakeFirst();
    if (row?.state === 'hidden') return dropHidden(db, d, id, signal);
    const file = m?.commons_file ?? null;
    if (file === null) {
      // No file any more (or no museum): the row goes first, then our copy, so a page never names a deleted object.
      if (row === undefined) return;
      await db.deleteFrom('museum_image').where('museum_id', '=', id).where('state', '<>', 'hidden').execute();
      if (row.public_key !== null) await deleteKeys(r2Of(d), imageKeys(row.public_key, row.widths ?? []), signal);
      return;
    }

    const info = await fetchJson(imageInfoUrl([file]), {}, http);
    if (!info.ok) throw requestError(info);
    const parsed = parseImageInfo(info.body, [file]);
    const result = parsed.ok ? parsed.results[0] : undefined;
    if (result === undefined) throw new JobError('commons_bad_response', { retry: false });
    if (result.state === 'invalid') throw new JobError(result.code, { retry: false });
    if (result.state === 'missing') {
      await writeSkipped(db, d, id, file, null, 'commons_file_missing', signal);
      return;
    }
    const verdict = judge(result);
    if (!verdict.ok) {
      await writeSkipped(db, d, id, file, result.sha1, verdict.code, signal);
      return;
    }
    // The same file and bytes as the active copy: only the licence and the credit can have moved.
    if (row?.state === 'active' && row.file === file && row.sha1 === result.sha1) {
      await db
        .updateTable('museum_image')
        .set({ licence: verdict.licence, attribution: verdict.attribution, checked_at: new Date() })
        .where('museum_id', '=', id)
        .where('state', '=', 'active')
        .execute();
      return;
    }

    const got = await fetchBytes(result.thumbUrl, {}, { ...http, maxBytes: COMMONS_MAX_BYTES });
    if (!got.ok) throw requestError(got);
    const ext = (await fileTypeFromBuffer(got.bytes))?.ext;
    const expect = ext === undefined ? undefined : FORMAT[ext];
    if (expect === undefined) {
      await writeSkipped(db, d, id, file, result.sha1, 'commons_type_not_allowed', signal);
      return;
    }

    // A fresh directory under the quarantine; a crash leaves it for the orphan sweep (a `c-` name is no uuid).
    const dir = join(root, `c-${newPublicKey()}`);
    let decoded: Awaited<ReturnType<Decode>>;
    try {
      await mkdir(dir, { mode: 0o700 });
      const path = join(dir, 'upload');
      const fh = await open(path, CREATE, 0o600);
      try {
        await fh.writeFile(got.bytes);
      } finally {
        await fh.close();
      }
      decoded = await (d.decode ?? createDecode())({ path, expect }, signal);
    } catch (err) {
      // The rendering does not decode (or breaks a limit): skipped, so the weekly sync does not fetch the same bytes
      // again; a new sha1 or file is a new try. A retryable failure (the role busy, an abort) is retried.
      if (err instanceof JobError && !err.retry) {
        await writeSkipped(db, d, id, file, result.sha1, 'commons_decode_failed', signal);
        d.logger?.warn({ code: err.code }, 'commons_decode_failed');
        return;
      }
      throw err;
    } finally {
      await removeTree(dir);
    }

    const publicKey = newPublicKey();
    const put: string[] = [];
    let old: string[] = [];
    const r2 = r2Of(d);
    try {
      for (const v of decoded.variants) {
        const key = imageKeys(publicKey, [v.width]).find((k) => k.endsWith(`.${v.format}`)) as string;
        put.push(key);
        await r2.put(key, v.bytes, { contentType: VARIANT_CONTENT_TYPE[v.format], cacheControl: IMMUTABLE, signal });
      }
      const widths = decoded.variants
        .filter((v) => v.format === 'avif')
        .map((v) => v.width)
        .sort((a, b) => a - b);
      const replaced = await commitRow(db, id, {
        file,
        sha1: result.sha1,
        licence: verdict.licence,
        attribution: verdict.attribution,
        public_key: publicKey,
        width: decoded.width,
        height: decoded.height,
        widths,
        state: 'active',
        skip_code: null,
      });
      // Hidden while this ran: the new objects must not stay.
      if (replaced === null) await deleteKeys(r2, put);
      else old = replaced;
    } catch (err) {
      await deleteKeys(r2, put).catch(() => {});
      throw err;
    }
    // Only now, with the row pointing at the new objects, do the previous image's go.
    await deleteKeys(r2, old, signal);
    d.logger?.info({ variants: decoded.variants.length }, 'commons_image_done');
  };
}
