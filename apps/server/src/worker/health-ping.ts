import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { Pinger } from '../lib/healthchecks.ts';
import type { Logger } from '../lib/log.ts';

// The worker's healthchecks.io ping (A§17.7, A8): the check `mjk-worker`, hourly. It is green
// while the newest applied museum sync (seed or weekly) finished less than 8 days ago, so one
// missed Tuesday run turns it red within a day of the next ping, and `/fail` otherwise. The
// check is made on the database's clock. A database that cannot answer sends `/fail` too.

export const WORKER_CHECK_SLUG = 'mjk-worker';
export const PING_EVERY_MS = 3_600_000;
export const SYNC_MAX_AGE_DAYS = 8;

/** True while the newest applied museum_sync_run finished within SYNC_MAX_AGE_DAYS. */
export async function lastSyncIsFresh(db: Db): Promise<boolean> {
  const { rows } = await sql<{ fresh: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM museum_sync_run
      WHERE outcome = 'applied' AND finished_at > now() - make_interval(days => ${SYNC_MAX_AGE_DAYS})
    ) AS fresh`.execute(db);
  return rows[0]?.fresh === true;
}

/** One ping: the check of the sync's age, then `success` or `fail`. Never throws. */
export async function pingWorkerHealth(db: Db, pinger: Pinger, logger: Logger): Promise<boolean> {
  let fresh = false;
  try {
    fresh = await lastSyncIsFresh(db);
  } catch {
    // No message: it can quote the connection.
    logger.error({}, 'health_check_failed');
  }
  if (!fresh) logger.warn({}, 'sync_stale');
  return pinger.ping(WORKER_CHECK_SLUG, fresh ? 'success' : 'fail');
}

/**
 * Pings now and then every hour until stopped. A pinger without a key does nothing: no query,
 * no timer (it has said `healthchecks_disabled` once when it was made).
 */
export function startHealthPing(opts: { db: Db; pinger: Pinger; logger: Logger; everyMs?: number }): { stop(): void } {
  const { db, pinger, logger } = opts;
  if (!pinger.enabled) return { stop: () => {} };
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pingWorkerHealth(db, pinger, logger);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, opts.everyMs ?? PING_EVERY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
