import { sql } from 'kysely';
import { ORIGINALS_DIR } from '../backup/plan.ts';
import type { Db } from '../db/kysely.ts';
import { enqueueIn } from '../worker/queue.ts';
import type { JobHandler } from '../worker/types.ts';
import { removeUpload } from './files.ts';
import { QUARANTINE_DIR } from './limits.ts';
import { type MediaJobDeps, mediaIdOf, r2Of, removeOriginal } from './publish.ts';
import { MEDIA_DELETE_JOB, MEDIA_PUBLISH_JOB } from './types.ts';

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

/**
 * The handler of `media_delete` jobs, as mjk_worker: a `removed` photo's R2 keys (a 404 is fine), its quarantine
 * directory, its original, then its row (the variants cascade). R2 is skipped, config and all, when no key can be
 * there: the photo was never approved and no `media_publish` job ever ran for it (a publish that died between its
 * PUTs and its UPDATE leaves keys without `decided_at`). Idempotent; any other state is a no-op.
 */
export function mediaDeleteJob(d: MediaJobDeps): JobHandler {
  return async (payload, { signal }) => {
    const id = mediaIdOf(payload);
    const { db } = d;
    const m = await db.selectFrom('media').select(['state', 'decided_at']).where('id', '=', id).executeTakeFirst();
    if (m !== undefined && m.state !== 'removed') return;
    if (m !== undefined) {
      const keys = await db.selectFrom('media_variant').select('object_key').where('media_id', '=', id).execute();
      const published =
        m.decided_at !== null ||
        (await db
          .selectFrom('job')
          .select('id')
          .where('kind', '=', MEDIA_PUBLISH_JOB)
          .where(sql`payload ->> 'media_id'`, '=', id)
          .limit(1)
          .executeTakeFirst()) !== undefined;
      if (published && keys.length > 0) {
        const r2 = r2Of(d);
        for (const k of keys) await r2.delete(k.object_key, { signal });
      }
    }
    await removeUpload(d.quarantineDir ?? QUARANTINE_DIR, id);
    await removeOriginal(d.originalsDir ?? ORIGINALS_DIR, id);
    if (m !== undefined) await db.deleteFrom('media').where('id', '=', id).where('state', '=', 'removed').execute();
  };
}
