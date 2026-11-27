import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { addReview, memberWithReview } from './fixtures.ts';

// P3a WP1 (db/migrations/20261129000001_reviews.sql): the review tables' constraints, the cascade proof of
// A§8's [U], the stats queue's unique index and what the public sees through the three pub_review* functions.

const UNIQUE = '23505';
const CHECK = '23514';
const FK = '23503';
// RESTRICT raises restrict_violation (NO ACTION would raise 23503), at the DELETE statement itself.
const DELETE_SQLSTATE = '23001';

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(() => p.close());

const ASPECTS = [
  'collection',
  'presentation',
  'kid_friendly',
  'accessibility',
  'facilities',
  'value_for_money',
] as const;
const ssr = (sql: string, params: unknown[] = []) => p.pools.ssr.query(sql, params);
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** One statement in a transaction that is always rolled back: 'ok' or its SQLSTATE and constraint. */
async function attempt(sql: string, params: unknown[] = []): Promise<string> {
  const c = await p.pools.api.connect();
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
const insertReview = (row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return attempt(
    `INSERT INTO review (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
};
/** A member with one visit to the museum, for a review that is never committed. */
async function ctx(museumIndex = 0) {
  const m = await p.visible(museumIndex);
  const u = await p.newMember();
  const visitId = await p.addVisit(u.id, m.id);
  return {
    userId: u.id,
    museumId: m.id,
    visitId,
    base: { user_id: u.id, museum_id: m.id, visit_id: visitId, rating: 3 },
  };
}

describe('review CHECKs', () => {
  it('the rating and each aspect are 1 to 5', async () => {
    const c = await ctx();
    expect(await insertReview({ ...c.base })).toBe('ok');
    for (const bad of [0, 6, -1]) expect(await insertReview({ ...c.base, rating: bad }), `rating ${bad}`).toBe(CHECK);
    expect(await insertReview({ ...c.base, rating: null })).toBe('23502');
    for (const a of ASPECTS) {
      for (const ok of [1, 5, null]) expect(await insertReview({ ...c.base, [a]: ok }), `${a} ${ok}`).toBe('ok');
      for (const bad of [0, 6]) expect(await insertReview({ ...c.base, [a]: bad }), `${a} ${bad}`).toBe(CHECK);
    }
  });

  it('the body is 1 to 5,000 code points, an emoji counts as one', async () => {
    const c = await ctx();
    expect(await insertReview({ ...c.base, body: 'x' })).toBe('ok');
    expect(await insertReview({ ...c.base, body: null })).toBe('ok');
    expect(await insertReview({ ...c.base, body: '' })).toBe(CHECK);
    expect(await insertReview({ ...c.base, body: 'x'.repeat(5000) })).toBe('ok');
    expect(await insertReview({ ...c.base, body: 'x'.repeat(5001) })).toBe(CHECK);
    const smile = cp(0x1f600);
    expect(await insertReview({ ...c.base, body: smile.repeat(5000) })).toBe('ok');
    expect(await insertReview({ ...c.base, body: smile.repeat(5001) })).toBe(CHECK);
  });

  it('each forbidden control or bidi code point fails, a newline and the neighbours pass', async () => {
    const c = await ctx();
    const forbidden: number[] = [];
    for (let i = 0x01; i <= 0x09; i++) forbidden.push(i);
    for (let i = 0x0b; i <= 0x1f; i++) forbidden.push(i);
    for (let i = 0x7f; i <= 0x9f; i++) forbidden.push(i);
    forbidden.push(0x2028, 0x2029);
    for (let i = 0x202a; i <= 0x202e; i++) forbidden.push(i);
    for (let i = 0x2066; i <= 0x2069; i++) forbidden.push(i);
    for (const code of forbidden) {
      const hex = code.toString(16);
      expect(await insertReview({ ...c.base, body: `a${cp(code)}b` }), `U+${hex}`).toBe(CHECK);
      expect(await insertReview({ ...c.base, body: cp(code) }), `U+${hex} alone`).toBe(CHECK);
    }
    // U+0000 cannot be stored in text at all (the driver or the server refuses it); it never reaches the CHECK.
    expect(await insertReview({ ...c.base, body: `a${cp(0)}b` })).not.toBe('ok');
    for (const ok of [0x0a, 0xa0, 0xa1, 0x2027, 0x202f, 0x2065, 0x206a, 0x1f600, 0xfeff])
      expect(await insertReview({ ...c.base, body: `a${cp(ok)}b` }), `U+${ok.toString(16)}`).toBe('ok');
    expect(await insertReview({ ...c.base, body: 'Eerste regel\nTweede regel' })).toBe('ok');
  });

  it('state is visible or removed, and defaults to visible', async () => {
    const c = await ctx();
    expect(await insertReview({ ...c.base, state: 'removed' })).toBe('ok');
    expect(await insertReview({ ...c.base, state: 'hidden' })).toBe(CHECK);
    const m = await p.visible(1);
    const r = await memberWithReview(p, m.id);
    const { rows } = await p.owner.query('SELECT state, former_member FROM review WHERE id = $1', [r.reviewId]);
    expect(rows[0]).toEqual({ state: 'visible', former_member: false });
  });

  it('the detach CHECKs: former_member = user_id is null, visit_id is null with it, the date only for it', async () => {
    const c = await ctx();
    const museum_id = c.museumId;
    const detached = { user_id: null, museum_id, visit_id: null, rating: 4, former_member: true };
    expect(await insertReview(detached)).toBe('ok');
    expect(await insertReview({ ...detached, former_visited_on: '2026-03-01' })).toBe('ok');
    // a detached row is not covered by the composite foreign key (MATCH SIMPLE), and several may coexist
    await p.owner.query(
      `INSERT INTO review (user_id, museum_id, visit_id, rating, former_member) VALUES (NULL, $1, NULL, 4, true), (NULL, $1, NULL, 5, true)`,
      [museum_id],
    );
    expect(await insertReview({ ...detached, former_member: false })).toBe(CHECK);
    expect(await insertReview({ ...detached, user_id: c.userId })).toBe(CHECK);
    expect(await insertReview({ ...detached, visit_id: c.visitId })).toBe(CHECK);
    expect(await insertReview({ ...c.base, former_member: true })).toBe(CHECK);
    expect(await insertReview({ ...c.base, visit_id: null })).toBe(CHECK);
    expect(await insertReview({ ...c.base, former_visited_on: '2026-03-01' })).toBe(CHECK);
    await p.owner.query('DELETE FROM review WHERE user_id IS NULL AND museum_id = $1', [museum_id]);
  });

  it('review_revision has the same CHECKs and one revision per edit', async () => {
    const m = await p.visible(2);
    const r = await memberWithReview(p, m.id);
    const rev = (row: Record<string, unknown>) => {
      const all = { review_id: r.reviewId, rating: 3, ...row };
      const cols = Object.keys(all);
      return attempt(
        `INSERT INTO review_revision (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      );
    };
    expect(await rev({})).toBe('ok');
    expect(await rev({ rating: 0 })).toBe(CHECK);
    expect(await rev({ rating: 6 })).toBe(CHECK);
    expect(await rev({ collection: 6 })).toBe(CHECK);
    expect(await rev({ value_for_money: 0 })).toBe(CHECK);
    expect(await rev({ body: '' })).toBe(CHECK);
    expect(await rev({ body: 'x'.repeat(5001) })).toBe(CHECK);
    expect(await rev({ body: `a${cp(0x202e)}b` })).toBe(CHECK);
    expect(await rev({ body: `a${cp(0x1f600)}\nb` })).toBe('ok');
    expect(await rev({ review_id: '00000000-0000-7000-8000-000000000000' })).toBe(FK);
  });
});

describe('review_once and the composite foreign key', () => {
  it('a member has one review per museum', async () => {
    const m = await p.visible(3);
    const r = await memberWithReview(p, m.id);
    const second = await p.addVisit(r.userId, m.id, { on: '2026-06-01' });
    expect(await insertReview({ user_id: r.userId, museum_id: m.id, visit_id: second, rating: 2 })).toBe(UNIQUE);
    const m2 = await p.visible(4);
    const v2 = await p.addVisit(r.userId, m2.id);
    expect(await insertReview({ user_id: r.userId, museum_id: m2.id, visit_id: v2, rating: 2 })).toBe('ok');
  });

  it('a visit of another member, or of another museum, is refused (review_cites_own_visit)', async () => {
    const m = await p.visible(5);
    const other = await p.visible(6);
    const a = await p.newMember();
    const b = await p.newMember();
    const bVisit = await p.addVisit(b.id, m.id);
    const aElsewhere = await p.addVisit(a.id, other.id);
    expect(await insertReview({ user_id: a.id, museum_id: m.id, visit_id: bVisit, rating: 3 })).toBe(FK);
    expect(await insertReview({ user_id: a.id, museum_id: m.id, visit_id: aElsewhere, rating: 3 })).toBe(FK);
    expect(await insertReview({ user_id: a.id, museum_id: m.id, visit_id: aElsewhere, rating: 3 })).toBe(FK);
    // the same refusal when an existing review is moved to a visit that is not its own (UPDATE visit_id)
    const mine = await p.addVisit(a.id, m.id);
    const id = await addReview(p, { userId: a.id, museumId: m.id, visitId: mine, rating: 3 });
    expect(await attempt('UPDATE review SET visit_id = $2 WHERE id = $1', [id, bVisit])).toBe(FK);
    expect(await attempt('UPDATE review SET visit_id = $2 WHERE id = $1', [id, aElsewhere])).toBe(FK);
    const again = await p.addVisit(a.id, m.id, { on: '2026-07-01' });
    expect(await attempt('UPDATE review SET visit_id = $2 WHERE id = $1', [id, again])).toBe('ok');
  });
});

describe('the RESTRICT question (A§8 [U])', () => {
  it('deleting an app_user removes its visits and reviews, although the review cites the visit', async () => {
    const m = await p.visible(7);
    const r = await memberWithReview(p, m.id);
    const second = await p.addVisit(r.userId, (await p.visible(8)).id);
    await p.owner.query("INSERT INTO review_revision (review_id, rating, body) VALUES ($1, 2, 'eerder')", [r.reviewId]);
    await p.owner.query('DELETE FROM app_user WHERE id = $1', [r.userId]);
    const count = async (sql: string, id: string) =>
      Number(((await p.owner.query(sql, [id])).rows[0] as { n: string }).n);
    expect(await count('SELECT count(*) AS n FROM app_user WHERE id = $1', r.userId)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM visit WHERE id = $1', r.visitId)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM visit WHERE id = $1', second)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM review WHERE id = $1', r.reviewId)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM review_revision WHERE review_id = $1', r.reviewId)).toBe(0);
  });

  it('a direct delete of a cited visit is refused at the statement, by constraint review_cites_own_visit', async () => {
    const m = await p.visible(9);
    const r = await memberWithReview(p, m.id);
    const c = await p.pools.api.connect();
    try {
      await c.query('BEGIN');
      const err = await c.query('DELETE FROM visit WHERE id = $1', [r.visitId]).then(
        () => null,
        (e: { code?: string; constraint?: string; table?: string }) => e,
      );
      expect(err, 'the DELETE statement itself raises').not.toBeNull();
      expect(err?.code).toBe(DELETE_SQLSTATE);
      expect(err?.constraint).toBe('review_cites_own_visit');
      expect(err?.table).toBe('review');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    // the visit and the review are untouched, and an uncited visit of the same member deletes fine
    expect((await p.owner.query('SELECT 1 FROM visit WHERE id = $1', [r.visitId])).rowCount).toBe(1);
    const spare = await p.addVisit(r.userId, m.id, { on: '2026-08-01' });
    expect(await attempt('DELETE FROM visit WHERE id = $1', [spare])).toBe('ok');
  });
});

describe('job_stats_queued_idx', () => {
  const insertJob = (kind: string, state: string) =>
    p.owner.query('INSERT INTO job (kind, state) VALUES ($1, $2)', [kind, state]).then(
      () => 'ok',
      (e: { code?: string }) => e.code ?? 'error',
    );
  it('a second queued stats_recompute conflicts, a running or finished one or another kind does not', async () => {
    await p.owner.query("DELETE FROM job WHERE kind = 'stats_recompute'");
    expect(await insertJob('stats_recompute', 'queued')).toBe('ok');
    expect(await insertJob('stats_recompute', 'queued')).toBe(UNIQUE);
    expect(await insertJob('stats_recompute', 'running')).toBe('ok');
    expect(await insertJob('stats_recompute', 'running')).toBe('ok');
    expect(await insertJob('stats_recompute', 'done')).toBe('ok');
    expect(await insertJob('museum_sync', 'queued')).toBe('ok');
    expect(await insertJob('museum_sync', 'queued')).toBe('ok');
    // what the writers do (stats-queue.ts): ON CONFLICT DO NOTHING against it
    const r = await p.pools.api.query(
      "INSERT INTO job (kind, payload, max_attempts) VALUES ('stats_recompute', '{}', 1) ON CONFLICT DO NOTHING",
    );
    expect(r.rowCount).toBe(0);
    await p.owner.query("UPDATE job SET state = 'done' WHERE kind = 'stats_recompute' AND state = 'queued'");
    const r2 = await p.pools.api.query(
      "INSERT INTO job (kind, payload, max_attempts) VALUES ('stats_recompute', '{}', 1) ON CONFLICT DO NOTHING",
    );
    expect(r2.rowCount).toBe(1);
  });
});

describe('museum_stats', () => {
  it('the counts are non-negative, the mean is null exactly when the count is 0 and otherwise 1 to 5', async () => {
    const m = await p.visible(10);
    const stats = (count: number, mean: number | null) =>
      p.pools.worker
        .query(
          `INSERT INTO museum_stats (museum_id, rating_count, rating_mean, bayes_score, collection_count, presentation_count,
             kid_friendly_count, accessibility_count, facilities_count, value_for_money_count, visit_count)
           VALUES ($1, $2, $3, 3.1, 0, 0, 0, 0, 0, 0, 0)`,
          [m.id, count, mean],
        )
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code ?? 'error',
        );
    expect(await stats(2, 6)).toBe(CHECK);
    expect(await stats(2, null)).toBe(CHECK);
    expect(await stats(0, 3)).toBe(CHECK);
    expect(await stats(-1, null)).toBe(CHECK);
    expect(await stats(0, null)).toBe('ok');
    await p.owner.query('DELETE FROM museum_stats WHERE museum_id = $1', [m.id]);
    expect(await stats(2, 4.5)).toBe('ok');
    expect(await stats(2, 4.5)).toBe(UNIQUE);
  });
});

// ---- the public functions ----------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const ofMuseum = async (id: string, before: string | null = null, limit = 50): Promise<Row[]> =>
  (await ssr('SELECT * FROM pub_reviews_of_museum($1, $2, $3)', [id, before, limit])).rows;
const ofUser = async (handle: string, before: string | null = null, limit = 50): Promise<Row[]> =>
  (await ssr('SELECT * FROM pub_reviews_of_user($1, $2, $3)', [handle, before, limit])).rows;
const one = async (id: string): Promise<Row[]> => (await ssr('SELECT * FROM pub_review($1)', [id])).rows;

describe('pub_review, pub_reviews_of_museum and pub_reviews_of_user', () => {
  it('return the same columns, never an id of the author or the visit, the state or a revision', async () => {
    const m = await p.visible(11);
    const r = await memberWithReview(p, m.id, { on: '2026-04-02', body: 'Prachtig\nbezoek' });
    const expected = [
      'id',
      'museum_id',
      'museum_slug',
      'museum_name',
      'museum_name_en',
      'author_handle',
      'author_display_name',
      'author_active',
      'former_member',
      'visited_on',
      'rating',
      ...ASPECTS,
      'body',
      'created_at',
      'edited_at',
    ];
    for (const rows of [await one(r.reviewId), await ofMuseum(m.id), await ofUser(r.handle)]) {
      expect(rows).toHaveLength(1);
      const row = rows[0] as Row;
      expect(Object.keys(row)).toEqual(expected);
      expect(row).toMatchObject({
        id: r.reviewId,
        museum_id: m.id,
        museum_slug: m.slug,
        author_handle: r.handle,
        author_display_name: 'Member',
        author_active: true,
        former_member: false,
        visited_on: '2026-04-02',
        rating: 4,
        body: 'Prachtig\nbezoek',
        edited_at: null,
      });
      expect(JSON.stringify(row)).not.toContain(r.userId);
      expect(JSON.stringify(row)).not.toContain(r.visitId);
    }
  });

  it('an undated visit gives a null visited_on', async () => {
    const m = await p.visible(12);
    const r = await memberWithReview(p, m.id, { on: null });
    expect((await one(r.reviewId))[0]?.visited_on).toBeNull();
  });

  it('a hidden museum, a removed review and a deleted author are absent', async () => {
    const m = await p.visible(13);
    const live = await memberWithReview(p, m.id);
    const removed = await memberWithReview(p, m.id);
    const gone = await memberWithReview(p, m.id);
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [removed.reviewId]);
    await p.owner.query("UPDATE app_user SET status = 'deleted' WHERE id = $1", [gone.userId]);
    expect((await ofMuseum(m.id)).map((r) => r.id)).toEqual([live.reviewId]);
    expect(await one(removed.reviewId)).toEqual([]);
    expect(await one(gone.reviewId)).toEqual([]);
    expect(await ofUser(removed.handle)).toEqual([]);
    expect(await ofUser(gone.handle)).toEqual([]);

    const hid = await p.hidden();
    const h = await memberWithReview(p, hid.id);
    expect(await ofMuseum(hid.id)).toEqual([]);
    expect(await one(h.reviewId)).toEqual([]);
    expect(await ofUser(h.handle)).toEqual([]);
  });

  it('a banned author keeps the review, without a handle and with author_active false', async () => {
    const m = await p.visible(14);
    const r = await memberWithReview(p, m.id);
    await p.owner.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [r.userId]);
    for (const rows of [await one(r.reviewId), await ofMuseum(m.id)]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ author_handle: null, author_active: false, former_member: false });
    }
    // the profile list answers active members only: a banned, a deleted and an unknown handle are the same empty result
    expect(await ofUser(r.handle)).toEqual([]);
    expect(await ofUser('nobody_at_all')).toEqual([]);
    expect(await ofUser(r.handle.toUpperCase())).toEqual([]);
  });

  it('a detached review stays as a former member, with the copied visit date', async () => {
    const m = await p.visible(15);
    const r = await memberWithReview(p, m.id);
    await p.owner.query(
      `UPDATE review SET user_id = NULL, visit_id = NULL, former_member = true, former_visited_on = '2026-02-03' WHERE id = $1`,
      [r.reviewId],
    );
    const rows = await ofMuseum(m.id);
    expect(rows.find((x) => x.id === r.reviewId)).toMatchObject({
      author_handle: null,
      author_display_name: null,
      author_active: false,
      former_member: true,
      visited_on: '2026-02-03',
    });
    expect(await one(r.reviewId)).toHaveLength(1);
    await p.owner.query('DELETE FROM review WHERE id = $1', [r.reviewId]);
  });

  it('the cap is 51, a limit below 1 gives one row, and p_before pages newest first without overlap', async () => {
    const m = await p.visible(16);
    // 120 members with a visit and a review each, in three set-based statements
    await p.owner.query(
      `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version, terms_accepted_at)
       SELECT 'page' || g || '@example.org', now(), 'page_' || g, 'P', now(), 'v1', now() FROM generate_series(1, 120) g`,
    );
    await p.owner.query(
      `INSERT INTO visit (user_id, museum_id, visited_on, source)
       SELECT id, $1, '2026-01-01', 'manual' FROM app_user WHERE handle::text LIKE 'page\\_%'`,
      [m.id],
    );
    await p.owner.query(
      `INSERT INTO review (user_id, museum_id, visit_id, rating)
       SELECT v.user_id, v.museum_id, v.id, 3 FROM visit v JOIN app_user u ON u.id = v.user_id
        WHERE u.handle::text LIKE 'page\\_%' AND v.museum_id = $1`,
      [m.id],
    );
    const all = (await p.owner.query('SELECT id FROM review WHERE museum_id = $1 ORDER BY id DESC', [m.id])).rows.map(
      (r) => r.id as string,
    );
    expect(all).toHaveLength(120);
    expect(await ofMuseum(m.id, null, 1000)).toHaveLength(51);
    expect(await ofMuseum(m.id, null, 51)).toHaveLength(51);
    expect(await ofMuseum(m.id, null, 0)).toHaveLength(1);
    expect(await ofMuseum(m.id, null, -5)).toHaveLength(1);
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Row[] = await ofMuseum(m.id, before, 50);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id as string));
      before = page.at(-1)?.id as string;
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(120);
    // the same walk for one member's list is one row long: p_before past it is empty
    const first = await memberWithReview(p, (await p.visible(17)).id);
    expect(await ofUser(first.handle, first.reviewId)).toEqual([]);
    expect(await ofUser(first.handle, null, 50)).toHaveLength(1);
  });

  it('the same order across museums for a member: newest review first', async () => {
    const u = await p.newMember();
    const ids: string[] = [];
    for (const i of [18, 19, 20]) {
      const m = await p.visible(i);
      ids.push(await addReview(p, { userId: u.id, museumId: m.id, visitId: await p.addVisit(u.id, m.id), rating: 5 }));
    }
    expect((await ofUser(u.handle)).map((r) => r.id)).toEqual([...ids].reverse());
  });
});
