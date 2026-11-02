// The weekly `museum_sync` job and the live fetchers (A§5, A§7.4). The job and
// the `sync-museums` role run the same runSync() as mjk_worker.

import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { JobError, type JobHandler } from '../worker/types.ts';
import { fetchRce } from './sources/rce.ts';
import { fetchWikidata, wikidataQuery } from './sources/wikidata.ts';
import { DEFAULT_SYNC_CONFIG, type Fetchers, runSync, type SyncConfig, type SyncResult } from './sync.ts';

export const MUSEUM_SYNC_JOB = 'museum_sync';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Wikidata and RCE as the sync reaches them: one request each, through the host
 * allowlist. `MJK_SYNC_CONTACT` (an email or https URL, config, not a secret)
 * goes into the User-Agent; an invalid value falls back to the repository URL.
 */
export function liveFetchers(env: Env): Fetchers {
  const deps = env.MJK_SYNC_CONTACT === undefined ? {} : { contact: env.MJK_SYNC_CONTACT };
  return { wikidata: () => fetchWikidata(wikidataQuery(), deps), rce: () => fetchRce(deps) };
}

/** A run that did not apply as the job's fixed code: a refusal is final, a failure is retried. */
export function jobErrorOf(r: SyncResult): JobError | undefined {
  if (r.outcome === 'applied' || r.outcome === 'dry_run') return undefined;
  return new JobError(r.code ?? 'internal', { retry: r.outcome === 'failed' });
}

/** The handler of `museum_sync` jobs; the job carries no payload. */
export function museumSyncJob(db: Db, fetchers: Fetchers, logger: Logger, cfg: SyncConfig = DEFAULT_SYNC_CONFIG) {
  const handler: JobHandler = async () => {
    const error = jobErrorOf(await runSync(db, fetchers, logger, { mode: 'sync' }, cfg));
    if (error) throw error;
  };
  return handler;
}
