import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { NOTIFY_CHANNEL } from '../worker/queue.ts';

// The debounced score recompute (A§8 `museum_stats`, P3a). Every write that changes a rating, or the set of
// museums, calls enqueueStats on its own transaction; at most one `stats_recompute` job is queued at a time
// (the partial unique index `job_stats_queued_idx`), and the handler recomputes every museum in one statement.
//
// Why the advisory lock (no lost update): a writer takes it shared before it queues, the handler takes it
// exclusive before it reads. A writer whose insert found a queued job holds the shared lock until it commits,
// so a handler that claimed that job waits for the writer and then reads its change; a writer that arrives
// after the claim finds no queued job and queues the next one. `max_attempts: 1`: a failed run never goes
// back into the unique index; the next change queues a fresh job.

export const STATS_KIND = 'stats_recompute';

/** The advisory lock key text (hashtext) that writers take shared and the handler exclusive. */
export const STATS_LOCK_KEY = 'mjk_stats_recompute';

/** Queues the recompute on the caller's transaction unless one is already queued; wakes the worker when it inserts. */
export async function enqueueStats(trx: Db): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${STATS_LOCK_KEY}::text))`.execute(trx);
  const row = await trx
    .insertInto('job')
    .values({ kind: STATS_KIND, payload: '{}', max_attempts: 1 })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (row !== undefined) await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${STATS_KIND})`.execute(trx);
}
