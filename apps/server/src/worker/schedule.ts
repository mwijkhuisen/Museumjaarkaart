import { Cron } from 'croner';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { enqueueUnique } from './queue.ts';

// The weekly museum sync [U → A§7.4]: Tuesday 03:17 Europe/Amsterdam, unless one is
// already queued or running. The quarterly tiles refresh (A§15.3, P1d Q5): the first Sunday of
// January, April, July and October at 02:23 Europe/Amsterdam, with the same guard.

export const MUSEUM_SYNC_PATTERN = '17 3 * * 2';
/** `0#1` is the first Sunday of the month. */
export const TILES_REFRESH_PATTERN = '23 2 * 1,4,7,10 0#1';
export const SCHEDULE_TIMEZONE = 'Europe/Amsterdam';
/** A quarterly job that fails on a flaky night tries again twice (15 and 30 minutes later), then waits for the owner. */
export const TILES_REFRESH_ATTEMPTS = 3;

export type Schedule = {
  /** The museum sync's croner job, for `nextRun()` and its options. */
  cron: Cron;
  /** The tiles refresh's. */
  tilesCron: Cron;
  stop(): void;
};

export function startSchedule(opts: { db: Db; logger: Logger }): Schedule {
  const { db, logger } = opts;
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
  return {
    cron,
    tilesCron,
    stop: () => {
      cron.stop();
      tilesCron.stop();
    },
  };
}
