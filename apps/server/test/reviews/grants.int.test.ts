import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { memberWithReview } from './fixtures.ts';

// P3a WP1 (db/migrations/20261129000001_reviews.sql): who may do what with the review tables, per login and
// per column, and that nothing reachable by mjk_ssr leaks a user id, a visit id, a state, a revision or visit_count.

const DENIED = '42501';
const UNDEFINED_COLUMN = '42703';
const ASPECTS = ['collection', 'presentation', 'kid_friendly', 'accessibility', 'facilities', 'value_for_money'];

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(() => p.close());

const sorted = (xs: readonly string[]) => [...xs].sort();
/** One statement in a transaction that is always rolled back: 'ok' or its SQLSTATE. */
async function attempt(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try {
      await c.query(sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    } finally {
      await c.query('ROLLBACK');
    }
  } finally {
    c.release();
  }
}
const columnsOf = async (table: string) =>
  (
    await p.owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      [table],
    )
  ).rows.map((r) => r.column_name);
/** The columns a login holds a column-level (or table-level, shown per column) privilege on. */
const columnGrants = async (login: string, table: string, privilege: 'SELECT' | 'INSERT' | 'UPDATE') =>
  (
    await p.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3`,
      [table, login, privilege],
    )
  ).rows
    .map((r) => r.column_name)
    .sort();

describe('column grants', () => {
  it('mjk_api updates only the visit, the rating, the aspects, the body and the edit time of a review', async () => {
    expect(await columnGrants('mjk_api', 'review', 'UPDATE')).toEqual(
      sorted(['visit_id', 'rating', ...ASPECTS, 'body', 'edited_at']),
    );
    expect(await columnGrants('mjk_api', 'review', 'INSERT')).toEqual(sorted(await columnsOf('review')));
    expect(await columnGrants('mjk_api', 'review', 'SELECT')).toEqual(sorted(await columnsOf('review')));
    for (const col of ['id', 'user_id', 'museum_id', 'state', 'former_member', 'former_visited_on', 'created_at'])
      expect(await attempt(p.pools.api, `UPDATE review SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    expect(await attempt(p.pools.api, 'UPDATE review SET rating = rating WHERE false')).toBe('ok');
    expect(await attempt(p.pools.api, 'UPDATE review SET edited_at = now() WHERE false')).toBe('ok');
  });

  it('mjk_api only inserts revisions: no read, no change, no delete', async () => {
    expect(await columnGrants('mjk_api', 'review_revision', 'INSERT')).toEqual(
      sorted(await columnsOf('review_revision')),
    );
    expect(await columnGrants('mjk_api', 'review_revision', 'SELECT')).toEqual([]);
    expect(await columnGrants('mjk_api', 'review_revision', 'UPDATE')).toEqual([]);
    expect(await attempt(p.pools.api, 'SELECT 1 FROM review_revision LIMIT 1')).toBe(DENIED);
    expect(await attempt(p.pools.api, 'SELECT count(*) FROM review_revision')).toBe(DENIED);
    expect(await attempt(p.pools.api, 'UPDATE review_revision SET rating = rating WHERE false')).toBe(DENIED);
    expect(await attempt(p.pools.api, 'DELETE FROM review_revision')).toBe(DENIED);
  });

  it('mjk_api reads the scores only through pub_museum_stats and cannot write them', async () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE'] as const)
      expect(await columnGrants('mjk_api', 'museum_stats', priv), priv).toEqual([]);
    expect(await attempt(p.pools.api, 'SELECT 1 FROM museum_stats LIMIT 1')).toBe(DENIED);
    expect(await attempt(p.pools.api, 'SELECT * FROM pub_museum_stats')).toBe('ok');
    expect(await attempt(p.pools.api, 'DELETE FROM museum_stats')).toBe(DENIED);
  });

  it('mjk_worker reads reviews and revisions, and reads and writes the scores', async () => {
    for (const t of ['review', 'review_revision']) {
      expect(await columnGrants('mjk_worker', t, 'SELECT'), t).toEqual(sorted(await columnsOf(t)));
      expect(await columnGrants('mjk_worker', t, 'INSERT'), t).toEqual([]);
      expect(await columnGrants('mjk_worker', t, 'UPDATE'), t).toEqual([]);
      expect(await attempt(p.pools.worker, `DELETE FROM ${t}`), t).toBe(DENIED);
    }
    const stats = sorted(await columnsOf('museum_stats'));
    for (const priv of ['SELECT', 'INSERT', 'UPDATE'] as const)
      expect(await columnGrants('mjk_worker', 'museum_stats', priv), priv).toEqual(stats);
    expect(await attempt(p.pools.worker, 'DELETE FROM museum_stats')).toBe(DENIED);
    // what the stats job needs: the reviews, the museums, the visits and the author's status
    const m = await p.visible(30);
    const r = await memberWithReview(p, m.id);
    expect(
      await attempt(
        p.pools.worker,
        `SELECT r.rating, m.hidden, u.status, (SELECT count(*) FROM visit v WHERE v.museum_id = m.id)
           FROM review r JOIN museum m ON m.id = r.museum_id JOIN app_user u ON u.id = r.user_id WHERE r.id = $1`,
        [r.reviewId],
      ),
    ).toBe('ok');
  });

  it('nobody holds TRUNCATE, REFERENCES or TRIGGER on the new tables and the view', async () => {
    const { rows } = await p.owner.query<{ login: string; tbl: string; priv: string }>(
      `SELECT l AS login, t AS tbl, pr AS priv
         FROM unnest($1::text[]) l, unnest($2::text[]) t, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
        WHERE has_table_privilege(l, 'public.' || t, pr)`,
      [
        ['mjk_api', 'mjk_worker', 'mjk_ssr', 'mjk_backup'],
        ['review', 'review_revision', 'museum_stats', 'pub_museum_stats'],
      ],
    );
    expect(rows).toEqual([]);
  });
});

describe('mjk_ssr', () => {
  it('is refused on review, review_revision and museum_stats', async () => {
    for (const t of ['review', 'review_revision', 'museum_stats'])
      expect(await attempt(p.pools.ssr, `SELECT 1 FROM ${t} LIMIT 1`), t).toBe(DENIED);
    for (const col of ['user_id', 'visit_id', 'state', 'body'])
      expect(await attempt(p.pools.ssr, `SELECT ${col} FROM review`), col).toBe(DENIED);
    expect(await attempt(p.pools.ssr, 'INSERT INTO museum_stats (museum_id) VALUES (gen_random_uuid())')).toBe(DENIED);
  });

  it('reads pub_museum_stats, which has no visit_count and no updated_at, and skips hidden museums', async () => {
    expect(await attempt(p.pools.ssr, 'SELECT * FROM pub_museum_stats')).toBe('ok');
    for (const col of ['visit_count', 'updated_at'])
      expect(await attempt(p.pools.ssr, `SELECT ${col} FROM pub_museum_stats`), col).toBe(UNDEFINED_COLUMN);
    const shown = await p.visible(31);
    const hidden = await p.hidden();
    for (const id of [shown.id, hidden.id])
      await p.owner.query(
        `INSERT INTO museum_stats (museum_id, rating_count, rating_mean, bayes_score, collection_count, presentation_count,
           kid_friendly_count, accessibility_count, facilities_count, value_for_money_count, visit_count)
         VALUES ($1, 3, 4.0, 4.1, 0, 0, 0, 0, 0, 0, 17)`,
        [id],
      );
    const { rows } = await p.pools.ssr.query('SELECT * FROM pub_museum_stats WHERE museum_id = ANY($1)', [
      [shown.id, hidden.id],
    ]);
    expect(rows.map((r) => r.museum_id)).toEqual([shown.id]);
    expect(rows[0]).toMatchObject({ rating_count: 3, rating_mean: 4, bayes_score: 4.1 });
    expect(Object.keys(rows[0])).not.toContain('visit_count');
    // the float8 filters pass below the barrier and use a number
    const f = await p.pools.ssr.query(
      'SELECT museum_id FROM pub_museum_stats WHERE rating_mean >= $1 AND rating_count >= 1',
      [4],
    );
    expect(f.rows.map((r) => r.museum_id)).toContain(shown.id);
  });

  it('runs the three review functions, and no function returns a user id, a visit id, a state, a note or a revision', async () => {
    const m = await p.visible(32);
    const r = await memberWithReview(p, m.id);
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_review($1)', [r.reviewId])).rowCount).toBe(1);
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_reviews_of_museum($1, NULL, 50)', [m.id])).rowCount).toBe(1);
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_reviews_of_user($1, NULL, 50)', [r.handle])).rowCount).toBe(1);
    expect(await attempt(p.pools.worker, 'SELECT * FROM pub_review($1)', [r.reviewId])).toBe(DENIED);

    // every output column of every review function, by catalog
    const { rows } = await p.owner.query<{ proname: string; names: string[]; modes: string[] }>(
      `SELECT proname, proargnames AS names, proargmodes::text[] AS modes FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'pub\\_review%' ORDER BY proname`,
    );
    expect(rows.map((x) => x.proname)).toEqual(['pub_review', 'pub_reviews_of_museum', 'pub_reviews_of_user']);
    for (const f of rows) {
      const out = f.names.filter((_, i) => f.modes[i] === 't');
      expect(out.length, f.proname).toBe(20);
      for (const bad of [
        'user_id',
        'visit_id',
        'state',
        'note',
        'revision',
        'review_id',
        'visit_count',
        'former_visited_on',
      ])
        expect(out, `${f.proname}.${bad}`).not.toContain(bad);
    }
    // and the data: the author's and the visit's ids appear nowhere in the three answers
    const text = JSON.stringify([
      (await p.pools.ssr.query('SELECT * FROM pub_review($1)', [r.reviewId])).rows,
      (await p.pools.ssr.query('SELECT * FROM pub_reviews_of_museum($1, NULL, 50)', [m.id])).rows,
      (await p.pools.ssr.query('SELECT * FROM pub_reviews_of_user($1, NULL, 50)', [r.handle])).rows,
    ]);
    expect(text).not.toContain(r.userId);
    expect(text).not.toContain(r.visitId);
  });

  it('the functions are definer functions with a pinned search_path and no EXECUTE for PUBLIC', async () => {
    const { rows } = await p.owner.query<{ proname: string; definer: boolean; config: string[]; volatile: string }>(
      `SELECT proname, prosecdef AS definer, proconfig AS config, provolatile AS volatile FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'pub\\_review%' ORDER BY proname`,
    );
    expect(rows).toHaveLength(3);
    for (const f of rows) {
      expect(f.definer, f.proname).toBe(true);
      expect(f.config, f.proname).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(f.volatile, f.proname).toBe('s');
    }
    const login = await p.owner.query<{ has: boolean }>(
      "SELECT has_function_privilege('mjk_backup', 'public.pub_review(uuid)', 'EXECUTE') AS has",
    );
    expect(login.rows[0]?.has).toBe(false);
  });
});
