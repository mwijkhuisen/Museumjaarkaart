import { Cron } from 'croner';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { type PurgeOpts, purge } from './purge.ts';
import { enqueueUnique } from './queue.ts';

// The weekly museum sync [U → A§7.4]: Tuesday 03:17 Europe/Amsterdam, unless one is
// already queued or running. The quarterly tiles refresh (A§15.3, P1d Q5): the first Sunday of
// January, April, July and October at 02:23 Europe/Amsterdam, with the same guard.

export const MUSEUM_SYNC_PATTERN = '17 3 * * 2';
/** `0#1` is the first Sunday of the month. */
export const TILES_REFRESH_PATTERN = '23 2 * 1,4,7,10 0#1';
/** The weekly Commons check (ADR-0018): Thursday 04:11, a day and a quiet hour away from the museum sync. */
export const COMMONS_SYNC_PATTERN = '11 4 * * 4';
export const PURGE_PATTERN = '*/10 * * * *';
export const SCHEDULE_TIMEZONE = 'Europe/Amsterdam';
/** A quarterly job that fails on a flaky night tries again twice (15 and 30 minutes later), then waits for the owner. */
export const TILES_REFRESH_ATTEMPTS = 3;

export type Schedule = {
  /** The museum sync's croner job, for `nextRun()` and its options. */
  cron: Cron;
  /** The tiles refresh's. */
  tilesCron: Cron;
  /** The Commons image check's. */
  commonsCron: Cron;
  /** The retention purge's. */
  purgeCron: Cron;
  stop(): void;
};

/** The directories the purge also cleans: the export bundles (P2c), the quarantine and media-work (P3b). */
export function startSchedule(opts: { db: Db; logger: Logger } & PurgeOpts): Schedule {
  const { db, logger, ...dirs } = opts;
  // protect: a run that is still busy (a slow database) is not started twice (F1's busy guard).
  const every = (pattern: string, kind: string, maxAttempts?: number) =>
    new Cron(pattern, { timezone: SCHEDULE_TIMEZONE, protect: true, name: kind }, async () => {
      try {
        const inserted = await enqueueUnique(db, kind, {}, maxAttempts === undefined ? {} : { maxAttempts });
        logger.info({ inserted }, `schedule_${kind}`);
      } catch {
        // No message: it can quote the connection.
        logger.error({}, 'schedule_failed');
      }
    });
  const cron = every(MUSEUM_SYNC_PATTERN, 'museum_sync');
  const tilesCron = every(TILES_REFRESH_PATTERN, 'tiles_refresh', TILES_REFRESH_ATTEMPTS);
  const commonsCron = every(COMMONS_SYNC_PATTERN, 'commons_sync');
  // The retention purge (A§13.2) runs here directly, with no job row.
  const purgeCron = new Cron(PURGE_PATTERN, { timezone: SCHEDULE_TIMEZONE, protect: true, name: 'purge' }, async () => {
    try {
      await purge(db, logger, dirs);
    } catch (err) {
      // The SQLSTATE if any, never the message (it can quote a value).
      const code = (err as { code?: unknown } | null)?.code;
      logger.error(
        { code: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'internal' },
        'purge_failed',
      );
    }
  });
  return {
    cron,
    tilesCron,
    commonsCron,
    purgeCron,
    stop: () => {
      cron.stop();
      tilesCron.stop();
      commonsCron.stop();
      purgeCron.stop();
    },
  };
}
