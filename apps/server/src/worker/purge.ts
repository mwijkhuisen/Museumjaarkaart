import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { removeUpload } from '../media/files.ts';
import { UNATTACHED_TTL_MS } from '../media/limits.ts';
import { markRemoved } from '../media/remove.ts';
import { removeTree } from '../media/remove-tree.ts';
import { MEDIA_DELETE_JOB, MEDIA_PROCESS_JOB } from '../media/types.ts';
import { purgeExportFiles } from '../passport/export/files.ts';

// The retention purge (A§13.2), every 10 minutes, as mjk_worker, on the database clock. Counts only in the
// log (invariant 8). audit_log is never touched here (its purge function comes in P3c).

const STEPS: Record<string, RawBuilder<unknown>> = {
  session: sql`DELETE FROM session WHERE expires_at < now() OR absolute_expires_at < now()`,
  email_code: sql`DELETE FROM email_code WHERE created_at < now() - interval '24 hours'`,
  // A minute of grace past the expiry: a spend checks the expiry with its own statement's clock, so a
  // replay that starts just before a purge can never find the spent row already gone (P2b review L4).
  auth_challenge: sql`DELETE FROM auth_challenge WHERE expires_at < now() - interval '1 minute'`,
  rate_limit: sql`DELETE FROM rate_limit WHERE window_end < now() - interval '24 hours'`,
  job: sql`DELETE FROM job WHERE state IN ('done', 'failed') AND finished_at < now() - interval '30 days'`,
  // A§9: an unsent sealed code is nulled at its expiry (10 minutes); a failed mail job keeps no sealed value.
  sealed_code: sql`UPDATE job SET payload = payload || '{"sealed": null}'::jsonb
    WHERE kind = 'mail_code' AND state <> 'running' AND payload -> 'sealed' <> 'null'::jsonb
      AND (state = 'failed' OR created_at < now() - interval '10 minutes')`,
  sealed_failed: sql`UPDATE job SET payload = payload
      || CASE kind WHEN 'mail_invite' THEN '{"sealed_code": null, "sealed_to": null}'::jsonb
                   ELSE '{"sealed_to": null}'::jsonb END
    WHERE kind IN ('mail_invite', 'mail_notice') AND state = 'failed'
      AND (payload -> 'sealed_to' <> 'null'::jsonb OR payload -> 'sealed_code' <> 'null'::jsonb)`,
  invite: sql`DELETE FROM invite WHERE expires_at < now() - interval '90 days'
    OR (uses >= max_uses AND used_at < now() - interval '90 days')`,
  content_ip_log: sql`DELETE FROM content_ip_log WHERE created_at < now() - interval '30 days'`,
  // A§10: the parsed rows of an import wait at most 7 days, confirmed or not (P2c pulls this forward from P3d).
  visit_import: sql`DELETE FROM visit_import WHERE created_at < now() - interval '7 days'`,
  // P2c: a job that never finished stops blocking the member's next request after an hour; the rows go after 7 days.
  data_export_stuck: sql`UPDATE data_export SET state = 'failed'
    WHERE state = 'queued' AND created_at < now() - interval '1 hour'`,
  data_export: sql`DELETE FROM data_export WHERE created_at < now() - interval '7 days'`,
};

// The photo sweepers (A§12, P3b): each statement is guarded on the state it expects, so a photo that moved on
// meanwhile is left alone. The rows go first, then their quarantine directories: a crash in between leaves an
// orphan directory, which the directory sweep below removes.
type Id = { id: string };
const MEDIA_FILES: Record<string, RawBuilder<Id>> = {
  // A§12: an upload left unfinished for 24 h (its chunk rows cascade).
  media_uploading: sql<Id>`DELETE FROM media WHERE state = 'uploading' AND created_at < now() - interval '24 hours'
    RETURNING id`,
  media_failed: sql<Id>`DELETE FROM media WHERE state = 'failed' AND updated_at < now() - interval '24 hours'
    RETURNING id`,
  // A photo whose media_process job is gone (failed, reaped or never there) would wait for ever.
  media_stalled: sql<Id>`UPDATE media m SET state = 'failed', error_code = 'media_stalled'
    WHERE m.state IN ('quarantined', 'processing') AND m.updated_at < now() - interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = ${MEDIA_PROCESS_JOB} AND j.state IN ('queued', 'running')
                        AND j.payload ->> 'media_id' = m.id::text)
    RETURNING m.id`,
};
const MEDIA_ROWS: Record<string, RawBuilder<unknown>> = {
  // A removed photo whose media_delete failed for good (or was purged) gets another one.
  media_requeued: sql`INSERT INTO job (kind, payload)
    SELECT ${MEDIA_DELETE_JOB}, jsonb_build_object('media_id', m.id) FROM media m
     WHERE m.state = 'removed' AND m.updated_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind = ${MEDIA_DELETE_JOB} AND j.state IN ('queued', 'running')
                         AND j.payload ->> 'media_id' = m.id::text)`,
};
/** The states whose quarantine directory is still needed. */
const LIVE = ['uploading', 'quarantined', 'processing', 'pending_review'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Older than any upload's create (its directory is made before the row commits) or any media task (≤ 130 s). */
const DIR_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Removes every entry of `dir` older than an hour that `keep` does not name, through descriptors (`removeTree`: a
 * link is removed, never followed, wherever it sits in the tree). No directory (a worker without the mount, tests): nothing to do.
 */
async function sweepDir(dir: string, keep: (names: string[]) => Promise<Set<string>>): Promise<number> {
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  });
  const old: string[] = [];
  for (const name of names) {
    const st = await lstat(join(dir, name)).catch(() => undefined);
    if (st !== undefined && Date.now() - st.mtimeMs > DIR_MAX_AGE_MS) old.push(name);
  }
  const kept = old.length === 0 ? new Set<string>() : await keep(old);
  let n = 0;
  for (const name of old) {
    if (kept.has(name)) continue;
    await removeTree(join(dir, name));
    n++;
  }
  return n;
}

async function liveIds(db: Db, names: string[]): Promise<Set<string>> {
  // Only uuids reach SQL (PostgreSQL would log a bad value's text, CLAUDE.md).
  const ids = names.filter((n) => UUID.test(n));
  if (ids.length === 0) return new Set();
  const rows = await db.selectFrom('media').select('id').where('id', 'in', ids).where('state', 'in', LIVE).execute();
  return new Set(rows.map((r) => r.id));
}

export type PurgeOpts = {
  /** The worker's `/srv/mjk/exports`: the bundles whose row is gone, failed or expired go too. */
  exportsDir?: string;
  /** `/srv/mjk/quarantine`: the files of the photos the sweepers remove, and orphan directories. */
  quarantineDir?: string;
  /** `/srv/mjk/media-work`: task directories the `media` role left behind. */
  mediaWorkDir?: string;
};

export async function purge(db: Db, logger: Logger, opts: PurgeOpts = {}): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, stmt] of Object.entries(STEPS)) {
    counts[name] = Number((await stmt.execute(db)).numAffectedRows ?? 0);
  }
  for (const [name, stmt] of Object.entries(MEDIA_FILES)) {
    const { rows } = await stmt.execute(db);
    counts[name] = rows.length;
    if (opts.quarantineDir !== undefined) for (const r of rows) await removeUpload(opts.quarantineDir, r.id);
  }
  // N1: a photo still unattached 7 days after its create is removed (the media_delete job does the rest).
  counts.media_unattached = (
    await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('media')
        .select('id')
        .where('review_id', 'is', null)
        .where('state', 'not in', ['removed', 'failed'])
        .where('created_at', '<', sql<Date>`now() - make_interval(secs => ${UNATTACHED_TTL_MS / 1000})`)
        .forUpdate()
        .execute();
      return markRemoved(
        trx,
        rows.map((r) => r.id),
      );
    })
  ).length;
  for (const [name, stmt] of Object.entries(MEDIA_ROWS)) {
    counts[name] = Number((await stmt.execute(db)).numAffectedRows ?? 0);
  }
  if (opts.exportsDir !== undefined) {
    const files = await purgeExportFiles(db, opts.exportsDir);
    counts.export_bundles = files.bundles;
    counts.export_tmp = files.tmp;
  }
  if (opts.quarantineDir !== undefined) {
    counts.media_orphan_dirs = await sweepDir(opts.quarantineDir, (names) => liveIds(db, names));
  }
  // The `media` role's task directories carry no media id; an hour-old one is dead whatever its photo.
  if (opts.mediaWorkDir !== undefined) {
    counts.media_work_dirs = await sweepDir(opts.mediaWorkDir, async () => new Set());
  }
  logger.info(counts, 'purge_done');
  return counts;
}
