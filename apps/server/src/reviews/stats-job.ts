import { ASPECTS } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { JobHandler } from '../worker/types.ts';
import { BAYES_C } from './score.ts';
import { STATS_KIND, STATS_LOCK_KEY } from './stats-queue.ts';

// The `stats_recompute` job (A§8 `museum_stats`, P3a), as mjk_worker: one upsert over every museum, in one
// READ COMMITTED transaction that first takes the stats advisory lock exclusive (stats-queue.ts says why that
// loses no change). Counted ratings: visible reviews on non-hidden museums whose author is not `deleted` (a
// detached review, user_id null, counts; a banned author's does). m is their mean over the catalogue, 0 with
// none. A recompute between two pages of a rank-ordered list can move a museum (A§14).

export const STATS_RECOMPUTE_JOB = STATS_KIND;

const aspectColumns = ASPECTS.flatMap((a) => [sql.ref(`${a}_count`), sql.ref(`${a}_mean`)]);
const aspectSelect = ASPECTS.map((a) => sql`count(r.${sql.ref(a)}), round(avg(r.${sql.ref(a)})::numeric, 1)::float8`);
const aspectUpdates = aspectColumns.map((c) => sql`${c} = excluded.${c}`);

/** Recomputes every museum's stats row; resolves with the number of rows written. */
export async function recomputeStats(db: Db): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${STATS_LOCK_KEY}::text))`.execute(trx);
    // The LEFT JOIN keeps museums without a counted rating (count 0, mean null, score m). The means round as
    // numeric, so 3.95 is 4.0, the value the UI shows and the filters compare.
    const res = await sql`
      WITH counted AS (
        SELECT r.* FROM review r
          JOIN museum m ON m.id = r.museum_id AND NOT m.hidden
          LEFT JOIN app_user u ON u.id = r.user_id
         WHERE r.state = 'visible' AND u.status IS DISTINCT FROM 'deleted'
      ), prior AS (
        SELECT coalesce(avg(rating), 0)::float8 AS mean FROM counted
      )
      INSERT INTO museum_stats AS s (museum_id, rating_count, rating_mean, bayes_score,
        ${sql.join(aspectColumns)}, visit_count, updated_at)
      SELECT m.id,
        count(r.id),
        round(avg(r.rating)::numeric, 1)::float8,
        (${BAYES_C}::float8 * (SELECT mean FROM prior) + coalesce(sum(r.rating), 0)::float8)
          / (${BAYES_C}::float8 + count(r.id)),
        ${sql.join(aspectSelect)},
        (SELECT count(*) FROM visit v WHERE v.museum_id = m.id),
        now()
      FROM museum m
      LEFT JOIN counted r ON r.museum_id = m.id
      GROUP BY m.id
      ON CONFLICT (museum_id) DO UPDATE SET
        rating_count = excluded.rating_count, rating_mean = excluded.rating_mean,
        bayes_score = excluded.bayes_score, ${sql.join(aspectUpdates)},
        visit_count = excluded.visit_count, updated_at = excluded.updated_at`.execute(trx);
    return Number(res.numAffectedRows ?? 0);
  });
}

/** The handler of `stats_recompute` jobs; the job carries no payload. */
export function statsRecomputeJob(db: Db): JobHandler {
  return async () => {
    await recomputeStats(db);
  };
}
