import { randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Db } from '../../db/kysely.ts';
import type { MuseumImage as MuseumImageTable } from '../../db/types.ts';
import { type MediaJobDeps, r2Of } from '../../media/publish.ts';
import type { R2Client } from '../../media/r2.ts';
import { variantKey } from '../../media/types.ts';
import { JobError } from '../../worker/types.ts';
import type { FetchBytesResult } from '../sources/http.ts';
import type { ImageInfoResult } from './api.ts';
import { attributionRequired, attributionText } from './attribution.ts';
import { licenceCode } from './licence.ts';

// What the two Commons jobs share (ADR-0018, A§12): the verdict on one file, the row write that never revives a
// hidden image, and the R2 keys of an image's variants. The database moves first and the objects after it, so a
// page never points at a deleted object.

export const COMMONS_SYNC_JOB = 'commons_sync';
export const COMMONS_IMAGE_JOB = 'commons_image';
export const COMMONS_MIME: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const COMMONS_MAX_BYTES = 25 * 1024 * 1024;

export type Row = Selectable<MuseumImageTable>;
export type Present = Extract<ImageInfoResult, { state: 'present' }>;
export type Verdict = { ok: true; licence: string; attribution: string | null } | { ok: false; code: string };

/** The licence, the credit and the type of one present file; the first failing check gives the fixed skip code. */
export function judge(p: Present): Verdict {
  const l = licenceCode(p.licence);
  if (!l.ok) return l;
  // A restriction (personality rights, a trademark, …) is not ours to judge: skipped (P3b security review L4).
  if (p.restrictions !== null) return { ok: false, code: 'commons_restricted' };
  const attribution = attributionText(p.attributionHtml);
  if (attribution === null && attributionRequired(l.code)) return { ok: false, code: 'commons_attribution_missing' };
  if (!COMMONS_MIME.includes(p.mime)) return { ok: false, code: 'commons_type_not_allowed' };
  return { ok: true, licence: l.code, attribution };
}

const RETRY = new Set(['timeout', 'network', 'rate_limited', 'http_status']);

/** A failed request as the job's fixed code; only a transient one retries. */
export function requestError(r: Extract<FetchBytesResult, { ok: false }>): JobError {
  return new JobError(`commons_${r.code}`, { retry: RETRY.has(r.code) });
}

export const newPublicKey = (): string => randomBytes(16).toString('hex');

/** `p/<key>/<w>.<avif|webp>` for each width of an image (the WebP twins of the AVIF widths). */
export function imageKeys(publicKey: string, widths: readonly number[]): string[] {
  return widths.flatMap((w) => [variantKey(publicKey, 'avif', w), variantKey(publicKey, 'webp', w)]);
}

export async function deleteKeys(r2: R2Client, keys: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const key of keys) await r2.delete(key, signal === undefined ? {} : { signal });
}

export type RowValues = {
  file: string;
  sha1: string | null;
  licence: string | null;
  attribution: string | null;
  public_key: string | null;
  width: number | null;
  height: number | null;
  widths: number[] | null;
  state: 'active' | 'skipped';
  skip_code: string | null;
};

/**
 * Writes the museum's row (insert or replace), unless it is `hidden`: a hide is never undone here. Returns the
 * keys of the image it replaced (to delete once the row is committed), or null for a hidden row (nothing written).
 */
export async function commitRow(db: Db, museumId: string, v: RowValues): Promise<string[] | null> {
  return db.transaction().execute(async (trx) => {
    const o = await trx
      .selectFrom('museum_image')
      .select(['state', 'public_key', 'widths'])
      .where('museum_id', '=', museumId)
      .forUpdate()
      .executeTakeFirst();
    if (o?.state === 'hidden') return null;
    const set = { ...v, checked_at: new Date() };
    await trx
      .insertInto('museum_image')
      .values({ museum_id: museumId, ...set })
      .onConflict((oc) => oc.column('museum_id').doUpdateSet(set))
      .execute();
    return o?.public_key == null || o.public_key === v.public_key ? [] : imageKeys(o.public_key, o.widths ?? []);
  });
}

/** `commitRow`, then the replaced image's objects go. False for a hidden row. */
export async function writeRow(
  db: Db,
  deps: MediaJobDeps,
  museumId: string,
  v: RowValues,
  signal?: AbortSignal,
): Promise<boolean> {
  const old = await commitRow(db, museumId, v);
  if (old === null) return false;
  if (old.length > 0) await deleteKeys(r2Of(deps), old, signal);
  return true;
}

/** A skipped row for the file: our copy is off the page at once and off R2 right after. */
export const writeSkipped = (
  db: Db,
  deps: MediaJobDeps,
  museumId: string,
  file: string,
  sha1: string | null,
  code: string,
  signal?: AbortSignal,
) =>
  writeRow(
    db,
    deps,
    museumId,
    {
      file,
      sha1,
      licence: null,
      attribution: null,
      public_key: null,
      width: null,
      height: null,
      widths: null,
      state: 'skipped',
      skip_code: code,
    },
    signal,
  );
