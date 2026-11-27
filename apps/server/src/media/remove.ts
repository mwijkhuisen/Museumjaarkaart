import type { Db } from '../db/kysely.ts';
import { enqueueIn } from '../worker/queue.ts';
import { MEDIA_DELETE_JOB } from './types.ts';

// Removing photos (A§12 "Removal"). The api holds no R2 key (A§16.2), so it only marks a photo `removed` and
// queues a `media_delete` job, in the caller's transaction; the worker's job deletes the variants (on R2 or in
// quarantine), the original and the row (WP4). A photo that is already removed or failed is left alone.

/** Marks these photos `removed` and queues one `media_delete` each; returns the ids it marked. */
export async function markRemoved(trx: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .updateTable('media')
    .set({ state: 'removed' })
    .where('id', 'in', ids)
    .where('state', 'not in', ['removed', 'failed'])
    .returning('id')
    .execute();
  for (const r of rows) await enqueueIn(trx, MEDIA_DELETE_JOB, { media_id: r.id }, {});
  return rows.map((r) => r.id);
}
