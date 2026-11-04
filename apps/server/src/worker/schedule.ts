import { Cron } from 'croner';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { enqueueUnique } from './queue.ts';

// The weekly museum sync [U → A§7.4]: Tuesday 03:17 Europe/Amsterdam, unless one is
// already queued or running.

export const MUSEUM_SYNC_PATTERN = '17 3 * * 2';
export const SCHEDULE_TIMEZONE = 'Europe/Amsterdam';

export type Schedule = {
  /** The croner job, for `nextRun()` and its options. */
  cron: Cron;
  stop(): void;
};

export function startSchedule(opts: { db: Db; logger: Logger }): Schedule {
  const { db, logger } = opts;
  const cron = new Cron(
    MUSEUM_SYNC_PATTERN,
    // protect: a run that is still busy (a slow database) is not started twice (F1's busy guard).
    { timezone: SCHEDULE_TIMEZONE, protect: true, name: 'museum_sync' },
    async () => {
      try {
        const inserted = await enqueueUnique(db, 'museum_sync', {});
        logger.info({ inserted }, 'schedule_museum_sync');
      } catch {
        // No message: it can quote the connection.
        logger.error({}, 'schedule_failed');
      }
    },
  );
  return { cron, stop: () => cron.stop() };
}
