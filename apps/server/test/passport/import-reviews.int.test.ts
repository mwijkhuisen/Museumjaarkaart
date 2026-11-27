import { TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeImports } from '../../src/api/routes/me-imports.ts';
import { BUCKETS, userKey } from '../../src/auth/limiter.ts';
import { parseMjk } from '../../src/passport/import/mjk.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P3a criterion 10: the CSV's rating and review columns. A rated row applies whole (its visit and its review)
// or not at all; no rate-limit write; one content_ip_log row per review; one queued stats_recompute.

let p: PassportDb;
let app: ReturnType<typeof meApp>;
beforeAll(async () => {
  p = await openPassportDb();
  app = meApp(p, mountMeImports);
}, 120_000);
afterAll(() => p.close());

type Preview = { id: string; rows: { row: number; status: string; error: string | null; rating: number | null }[] };
const member = async () => {
  const u = await p.newMember();
  return { id: u.id, token: await app.signIn(u.id) };
};
const upload = async (token: string, content: string) => {
  const r = await app.call('/me/imports', { token, body: { format: 'csv', content } });
  expect(r.status).toBe(201);
  return (await r.json()) as Preview;
};
const confirm = (token: string, id: string, body: object = { choose: [], skip: [] }) =>
  app.call(`/me/imports/${id}/confirm`, { token, body });
const n = async (text: string, params: unknown[] = []) =>
  Number(((await p.owner.query(text, params)).rows[0] as { n: string }).n);
const reviews = (uid: string) => n('SELECT count(*) AS n FROM review WHERE user_id = $1', [uid]);
const visits = (uid: string) => n('SELECT count(*) AS n FROM visit WHERE user_id = $1', [uid]);
const queued = () => n("SELECT count(*) AS n FROM job WHERE kind = 'stats_recompute' AND state = 'queued'");
const clearQueue = () => p.admin.query("DELETE FROM job WHERE kind = 'stats_recompute'");

describe('CSV ratings and reviews', () => {
  it('creates the visits and the reviews from Dutch and English headers, with the side effects', async () => {
    const [a, b, c] = [await p.visible(10), await p.visible(11), await p.visible(12)];
    for (const [header, rows] of [
      [
        'museum_id;datum;beoordeling;recensie',
        [`${a.id};2026-03-01;5;"Prachtig\r\nSchitterend"`, `${b.id};2026-03-02;4;`],
      ],
      ['museum_id,date,stars,review', [`${a.id},2026-03-01,5,"Prachtig\r\nSchitterend"`, `${b.id},2026-03-02,4,`]],
    ] as const) {
      const u = await member();
      await clearQueue();
      const hitsBefore = await n('SELECT count(*) AS n FROM rate_limit WHERE bucket = $1', [
        BUCKETS.reviewUserDay.name,
      ]);
      const pre = await upload(u.token, [header, ...rows, `${c.id}${header.includes(';') ? ';' : ','}`].join('\n'));
      expect(pre.rows.map((r) => r.error)).toEqual([null, null, null]);
      const r = await confirm(u.token, pre.id);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ visits: 3, wishlist: 0, reviews: 2, skipped: 0 });
      const got = await p.owner.query<{ museum_id: string; rating: number; body: string | null; visited_on: string }>(
        `SELECT r.museum_id, r.rating, r.body, v.visited_on::text AS visited_on
           FROM review r JOIN visit v ON v.id = r.visit_id WHERE r.user_id = $1 ORDER BY r.rating DESC`,
        [u.id],
      );
      expect(got.rows).toEqual([
        { museum_id: a.id, rating: 5, body: 'Prachtig\nSchitterend', visited_on: '2026-03-01' },
        { museum_id: b.id, rating: 4, body: null, visited_on: '2026-03-02' },
      ]);
      expect(
        await n("SELECT count(*) AS n FROM content_ip_log WHERE user_id = $1 AND target_kind = 'review'", [u.id]),
      ).toBe(2);
      // No write counts against the review's daily bucket (plan Q7).
      expect(await n('SELECT count(*) AS n FROM rate_limit WHERE bucket = $1', [BUCKETS.reviewUserDay.name])).toBe(
        hitsBefore,
      );
      expect(
        await n('SELECT count(*) AS n FROM rate_limit WHERE bucket = $1 AND key = $2', [
          BUCKETS.reviewUserDay.name,
          userKey(app.keys, 'review', u.id),
        ]),
      ).toBe(0);
      expect(await queued()).toBe(1);
    }
  });

  it('an existing visit is cited, not duplicated', async () => {
    const m = await p.visible(13);
    const u = await member();
    await p.addVisit(u.id, m.id, { on: '2026-04-01' });
    const pre = await upload(u.token, `museum_id,datum,rating\n${m.id},2026-04-01,3\n`);
    expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 0, wishlist: 0, reviews: 1, skipped: 0 });
    expect(await visits(u.id)).toBe(1);
    expect(await reviews(u.id)).toBe(1);
  });

  it('a bad row applies nothing: neither its visit nor its review', async () => {
    const [a, b] = [await p.visible(14), await p.visible(15)];
    const u = await member();
    const pre = await upload(
      u.token,
      `museum_id,datum,rating,review\n${a.id},2026-04-01,9,x\n${b.id},2026-04-02,,woorden\n${a.id},2026-04-03,4,ok\n`,
    );
    expect(pre.rows.map((r) => [r.status, r.error])).toEqual([
      ['invalid', 'bad_rating'],
      ['invalid', 'bad_rating'],
      ['matched', null],
    ]);
    expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 1, wishlist: 0, reviews: 1, skipped: 0 });
    expect(await visits(u.id)).toBe(1);
  });

  it('refuses a second rated row for a museum, an existing review and a closed museum at preview', async () => {
    const [a, b, closed] = [await p.visible(16), await p.visible(17), await p.visible(18)];
    await p.owner.query("UPDATE museum SET closed_on = '2020-01-01' WHERE id = $1", [closed.id]);
    const u = await member();
    const v = await p.addVisit(u.id, b.id, { on: '2026-01-01' });
    await p.pools.api.query('INSERT INTO review (user_id, museum_id, visit_id, rating) VALUES ($1, $2, $3, 3)', [
      u.id,
      b.id,
      v,
    ]);
    await clearQueue();
    const pre = await upload(
      u.token,
      [
        'museum_id,datum,rating',
        `${a.id},2026-05-01,5`,
        `${a.id},2026-05-02,2`,
        `${b.id},2026-05-03,4`,
        `${closed.id},2026-05-04,4`,
      ].join('\n'),
    );
    expect(pre.rows.map((r) => [r.status, r.error])).toEqual([
      ['matched', null],
      ['invalid', 'review_exists'],
      ['invalid', 'review_exists'],
      ['invalid', 'museum_closed'],
    ]);
    expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 1, wishlist: 0, reviews: 1, skipped: 0 });
    expect(await n('SELECT rating AS n FROM review WHERE user_id = $1 AND museum_id = $2', [u.id, a.id])).toBe(5);
    expect(await visits(u.id)).toBe(2);
  });

  it('refuses at confirm, whole, when the state changed since the preview', async () => {
    const [a, b, c] = [await p.visible(19), await p.visible(20), await p.visible(21)];
    const u = await member();
    const pre = await upload(
      u.token,
      ['museum_id,datum,rating', `${a.id},2026-06-01,5`, `${b.id},2026-06-02,4`, `${c.id},2026-06-03,3`].join('\n'),
    );
    expect(pre.rows.every((r) => r.status === 'matched')).toBe(true);
    // Between preview and confirm: a closes, b gets a review by another visit, c stays fine.
    await p.owner.query("UPDATE museum SET closed_on = '2020-01-01' WHERE id = $1", [a.id]);
    const v = await p.addVisit(u.id, b.id, { on: '2026-02-02' });
    await p.pools.api.query('INSERT INTO review (user_id, museum_id, visit_id, rating) VALUES ($1, $2, $3, 2)', [
      u.id,
      b.id,
      v,
    ]);
    await clearQueue();
    expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 1, wishlist: 0, reviews: 1, skipped: 2 });
    // a's visit did not stay; b has only its earlier visit; c has visit and review.
    expect(await n('SELECT count(*) AS n FROM visit WHERE user_id = $1 AND museum_id = $2', [u.id, a.id])).toBe(0);
    expect(await n('SELECT count(*) AS n FROM visit WHERE user_id = $1 AND museum_id = $2', [u.id, b.id])).toBe(1);
    expect(await n('SELECT rating AS n FROM review WHERE user_id = $1 AND museum_id = $2', [u.id, b.id])).toBe(2);
    expect(await reviews(u.id)).toBe(2);
    expect(
      await n("SELECT count(*) AS n FROM content_ip_log WHERE user_id = $1 AND target_kind = 'review'", [u.id]),
    ).toBe(1);
    expect(await queued()).toBe(1);
  });

  it('a second rated row for a chosen museum is skipped at confirm and the first stands', async () => {
    const m = await p.visible(22);
    const u = await member();
    const pre = await upload(
      u.token,
      'museum,datum,rating\nNiet bestaand museum xyzzy,2026-06-01,5\nNog een xyzzy,2026-06-02,2\n',
    );
    expect(pre.rows.map((r) => r.status)).toEqual(['unmatched', 'unmatched']);
    const choose = pre.rows.map((r) => ({ row: r.row, museum_id: m.id }));
    expect(await (await confirm(u.token, pre.id, { choose, skip: [] })).json()).toEqual({
      visits: 1,
      wishlist: 0,
      reviews: 1,
      skipped: 1,
    });
    expect(await n('SELECT rating AS n FROM review WHERE user_id = $1', [u.id])).toBe(5);
    expect(await visits(u.id)).toBe(1);
  });

  it('no client address: 429 before the import is claimed, and it can be confirmed later', async () => {
    const m = await p.visible(23);
    const u = await member();
    const pre = await upload(u.token, `museum_id,datum,rating\n${m.id},2026-06-01,4\n`);
    app.state.peer = undefined;
    const refused = await confirm(u.token, pre.id);
    app.state.peer = '203.0.113.7';
    expect(refused.status).toBe(429);
    expect(await n("SELECT count(*) AS n FROM visit_import WHERE id = $1 AND state = 'pending'", [pre.id])).toBe(1);
    expect(await visits(u.id)).toBe(0);
    expect((await confirm(u.token, pre.id)).status).toBe(200);
    expect(await reviews(u.id)).toBe(1);
  });

  it('a file without the columns, and an unrated confirm, queue nothing and need no address', async () => {
    const m = await p.visible(24);
    const u = await member();
    await clearQueue();
    const pre = await upload(u.token, `museum_id,datum\n${m.id},2026-06-01\n`);
    app.state.peer = undefined;
    const r = await confirm(u.token, pre.id);
    app.state.peer = '203.0.113.7';
    expect(await r.json()).toEqual({ visits: 1, wishlist: 0, reviews: 0, skipped: 0 });
    expect(await queued()).toBe(0);
  });

  it('old terms: a rated file is a 403 and stays pending until the member accepts; an unrated file needs none', async () => {
    const [m, plain] = [await p.visible(25), await p.visible(26)];
    const u = await member();
    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [u.id, '2020-01-01']);
    const pre = await upload(u.token, `museum_id,datum,rating\n${m.id},2026-06-01,4\n`);
    const refused = await confirm(u.token, pre.id);
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'terms_required' }]);
    expect(await n("SELECT count(*) AS n FROM visit_import WHERE id = $1 AND state = 'pending'", [pre.id])).toBe(1);
    expect(await visits(u.id)).toBe(0);
    expect(await reviews(u.id)).toBe(0);

    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [u.id, TERMS_VERSION]);
    expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 1, wishlist: 0, reviews: 1, skipped: 0 });

    // P2c's behaviour: a file without ratings needs only a member.
    const v = await member();
    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [v.id, '2020-01-01']);
    const unrated = await upload(v.token, `museum_id,datum\n${plain.id},2026-06-01\n`);
    const r = await confirm(v.token, unrated.id);
    expect([r.status, await r.json()]).toEqual([200, { visits: 1, wishlist: 0, reviews: 0, skipped: 0 }]);
  });

  it('a database error in a rated row fails the whole confirm (still pending); a constraint error skips its row', async () => {
    const [a, b] = [await p.visible(27), await p.visible(28)];
    // A trigger on b's reviews stands in for a timeout or a deadlock (40P01), then for a lost race (23514).
    const failOn = (code: string) =>
      p.owner.query(`CREATE OR REPLACE FUNCTION test_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.museum_id = '${b.id}' THEN RAISE EXCEPTION 'forced' USING ERRCODE = '${code}'; END IF;
        RETURN NEW; END $$`);
    await failOn('40P01');
    await p.owner.query(
      'CREATE TRIGGER test_fail_review BEFORE INSERT ON review FOR EACH ROW EXECUTE FUNCTION test_fail_review()',
    );
    try {
      const u = await member();
      const pre = await upload(u.token, `museum_id,datum,rating\n${a.id},2026-07-01,5\n${b.id},2026-07-02,4\n`);
      expect((await confirm(u.token, pre.id)).status).toBe(500);
      expect(await n("SELECT count(*) AS n FROM visit_import WHERE id = $1 AND state = 'pending'", [pre.id])).toBe(1);
      expect(await visits(u.id)).toBe(0);
      expect(await reviews(u.id)).toBe(0);

      await failOn('23514');
      expect(await (await confirm(u.token, pre.id)).json()).toEqual({ visits: 1, wishlist: 0, reviews: 1, skipped: 1 });
      expect(await n('SELECT count(*) AS n FROM visit WHERE user_id = $1 AND museum_id = $2', [u.id, b.id])).toBe(0);
    } finally {
      await p.owner.query('DROP TRIGGER test_fail_review ON review');
      await p.owner.query('DROP FUNCTION test_fail_review()');
    }
  });

  it('the mjk importer ignores a reviews key', () => {
    const doc = {
      format: 'mjk',
      version: 1,
      visits: [{ museum: { name: 'A' }, visited_on: '2026-01-01' }],
      reviews: [{ rating: 5 }],
    };
    expect(parseMjk(JSON.stringify(doc), '2026-11-27')).toMatchObject({ ok: true, rows: [{ rating: null }] });
  });
});
