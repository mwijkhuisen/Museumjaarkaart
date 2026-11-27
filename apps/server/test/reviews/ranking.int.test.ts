import { MuseumList, MuseumPoints } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, buildApp } from '../../src/api/app.ts';
import { mountMuseumsList } from '../../src/api/routes/museums-list.ts';
import { mountMuseumsPoints } from '../../src/api/routes/museums-points.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { getMuseumDetail } from '../../src/museums/detail.ts';
import { findNearest } from '../../src/museums/near.ts';
import { ASPECT_MIN, BAYES_C, bayes } from '../../src/reviews/score.ts';
import { recomputeStats } from '../../src/reviews/stats-job.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { addReview } from './fixtures.ts';

// P3a WP4, criterion 4: the Bayesian score, the rank order and the two rating filters, through
// GET /museums?sort=rank, GET /museums/points, near-me and the detail. Tests run in file order and each
// adds reviews: the first one needs the catalogue mean m to be exactly 4.2.

type Museum = { id: string; slug: string; lat: number; lon: number };

let p: PassportDb;
let app: ApiApp;
let pool: Museum[]; // visible museums with coordinates, in id order
let next = 0;
const take = (): Museum => {
  const m = pool[next++];
  if (m === undefined) throw new Error('out of fixture museums');
  return m;
};

beforeAll(async () => {
  p = await openPassportDb();
  app = buildApp({ db: p.db, logger: silentLogger, ping: async () => true }, (v1, deps) => {
    mountMuseumsList(v1, deps);
    mountMuseumsPoints(v1, deps);
  });
  pool = (
    await p.owner.query<Museum>(
      'SELECT id, slug, lat, lon FROM museum WHERE NOT hidden AND lat IS NOT NULL ORDER BY id LIMIT 40',
    )
  ).rows;
}, 120_000);
afterAll(() => p?.close());

/** A new member who rates `museumId` (citing a visit of theirs); `kid` sets the kid-friendly aspect. */
async function rate(museumId: string, rating: number, kid: number | null = null): Promise<void> {
  const u = await p.newMember();
  const visitId = await p.addVisit(u.id, museumId);
  await addReview(p, { userId: u.id, museumId, visitId, rating, kid_friendly: kid });
}
const rateMany = async (museumId: string, ratings: number[], kid?: number[]) => {
  for (const [i, r] of ratings.entries()) await rate(museumId, r, kid?.[i] ?? null);
};

const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const get = (path: string) => app.request(`http://localhost/api/v1${path}`);
async function listOf(params: Record<string, string>) {
  const r = await get(`/museums?${new URLSearchParams(params)}`);
  expect(r.status, JSON.stringify(params)).toBe(200);
  return MuseumList.parse(await r.json());
}
async function walk(params: Record<string, string>) {
  const items: MuseumList['items'] = [];
  let cursor: string | null = null;
  do {
    const page: MuseumList = await listOf({ ...params, ...(cursor === null ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return items;
}
async function pointsOf(params: Record<string, string>) {
  const r = await get(`/museums/points?${new URLSearchParams(params)}`);
  expect(r.status).toBe(200);
  return MuseumPoints.parse(await r.json()).items.map((i) => i.id);
}

/** Every museum's stored score against bayes() over its counted ratings, within 1e-9. Returns m. */
async function checkScores(): Promise<number> {
  const rows = (
    await p.owner.query<{ museum_id: string; rating: number }>(
      `SELECT r.museum_id, r.rating FROM review r JOIN museum m ON m.id = r.museum_id
        WHERE r.state = 'visible' AND NOT m.hidden`,
    )
  ).rows;
  const all = rows.map((r) => r.rating);
  const m = all.length === 0 ? 0 : all.reduce((a, b) => a + b, 0) / all.length;
  const of = new Map<string, number[]>();
  for (const r of rows) of.set(r.museum_id, [...(of.get(r.museum_id) ?? []), r.rating]);
  const stats = (
    await p.owner.query<{ museum_id: string; bayes_score: number; rating_count: number; rating_mean: number | null }>(
      'SELECT museum_id, bayes_score, rating_count, rating_mean FROM museum_stats',
    )
  ).rows;
  expect(stats.length).toBe(p.catalogue.total);
  for (const s of stats) {
    const ratings = of.get(s.museum_id) ?? [];
    expect(Math.abs(s.bayes_score - bayes(BAYES_C, m, ratings))).toBeLessThan(1e-9);
    expect(s.rating_count).toBe(ratings.length);
    expect(s.rating_mean === null).toBe(ratings.length === 0);
  }
  return m;
}

describe('the Bayesian rank (criterion 4)', () => {
  let single: Museum;
  let forty: Museum;
  let weak: Museum;

  it('40 ratings averaging 4.6 rank above one 5, with m = 4.2 over the catalogue', async () => {
    single = take();
    forty = take();
    weak = take();
    await rate(single.id, 5);
    await rateMany(forty.id, [...Array(24).fill(5), ...Array(16).fill(4)]); // 184 / 40 = 4.6
    await rateMany(weak.id, [...Array(6).fill(2), ...Array(3).fill(3)]); // 21 / 9, so all: 210 / 50 = 4.2
    expect(await recomputeStats(p.worker)).toBe(p.catalogue.total);
    expect(await checkScores()).toBeCloseTo(4.2, 12);

    const score = async (id: string) =>
      (await p.owner.query<{ bayes_score: number }>('SELECT bayes_score FROM museum_stats WHERE museum_id = $1', [id]))
        .rows[0]?.bayes_score as number;
    expect(Math.abs((await score(single.id)) - bayes(BAYES_C, 4.2, [5]))).toBeLessThan(1e-9);
    expect(Math.abs((await score(forty.id)) - 205 / 45)).toBeLessThan(1e-9);
    expect(await score(forty.id)).toBeGreaterThan(await score(single.id));

    // through the route: the 40 first, the single 5 second, the unrated (score m = 4.2) after, the weak one last
    const page = await listOf({ sort: 'rank', limit: '3' });
    expect(page.items.map((i) => i.id).slice(0, 2)).toEqual([forty.id, single.id]);
    expect(page.items[0]).toMatchObject({ rating_count: 40, rating_mean: 4.6 });
    expect(page.items[1]).toMatchObject({ rating_count: 1, rating_mean: 5 });
    const all = await walk({ limit: '50' });
    expect(all.at(-1)?.id).toBe(weak.id);
    expect(all.find((i) => i.id === weak.id)).toMatchObject({ rating_count: 9, rating_mean: 2.3 });
  }, 120_000);

  it('rank is the default and pages through the whole catalogue: each museum once, in score order', async () => {
    const stats = (
      await p.owner.query<{ id: string; sort_name: string; score: number }>(
        `SELECT m.id, m.sort_name, coalesce(s.bayes_score, 0) AS score
           FROM pub_museum m LEFT JOIN pub_museum_stats s ON s.museum_id = m.id`,
      )
    ).rows;
    const byKey = (a: (typeof stats)[number], b: (typeof stats)[number]) =>
      byCodePoint(a.sort_name, b.sort_name) || byCodePoint(a.id, b.id);
    const want = [...stats].sort((a, b) => b.score - a.score || byKey(a, b)).map((r) => r.id);
    for (const params of [{ limit: '33' }, { sort: 'rank', limit: '50' }]) {
      const got = await walk(params);
      expect(got.map((i) => i.id)).toEqual(want);
      expect(new Set(got.map((i) => i.id)).size).toBe(want.length);
      expect((await listOf({ ...params, limit: '1' })).total).toBe(want.length);
    }
    // sort=name still orders by name, whatever the scores
    const byName = await walk({ sort: 'name', limit: '50' });
    expect(byName.map((i) => i.id)).toEqual([...stats].sort(byKey).map((r) => r.id));
  }, 120_000);

  it('accepts a rank cursor with any finite score and rejects the wrong mode', async () => {
    const { encodeCursor } = await import('../../src/museums/cursor.ts');
    const id = '00000000-0000-4000-8000-000000000000';
    for (const s of [0, 4.2, 5, 5e-324]) {
      const page = await listOf({ cursor: encodeCursor({ m: 'r', s, k: 'a', i: id }), limit: '5' });
      // rank order is descending, so a cursor at score 0 (or next to it) has only score-0 museums after it
      expect(page.items.length).toBe(s >= 4.2 ? 5 : 0);
    }
    const r = await get(`/museums?${new URLSearchParams({ cursor: encodeCursor({ m: 'n', k: 'a', i: id }) })}`);
    expect(r.status).toBe(400);
  });

  it('a museum without a stats row ranks last (coalesce 0)', async () => {
    const gone = pool[39] as Museum;
    await p.owner.query('DELETE FROM museum_stats WHERE museum_id = $1', [gone.id]);
    const all = await walk({ limit: '50' });
    expect(all.at(-1)).toMatchObject({ id: gone.id, rating_count: 0, rating_mean: null });
    expect(all.at(-2)?.id).toBe(weak.id);
    await recomputeStats(p.worker);
    expect((await walk({ limit: '50' })).at(-1)?.id).toBe(weak.id);
  }, 120_000);

  it('a recompute between two pages moves m but skips or repeats no other museum', async () => {
    // Museums outside `pool` (no coordinates), so the later tests' picks stay the same.
    const extra = (
      await p.owner.query<{ id: string }>('SELECT id FROM museum WHERE NOT hidden AND lat IS NULL ORDER BY id LIMIT 2')
    ).rows.map((r) => r.id);
    expect(extra.length).toBe(2);
    const total = (await listOf({ limit: '1' })).total;
    // m up (a new 5) and m down (a new 1): each shifts the score of every unrated museum, the anchors' too.
    for (const [museumId, rating] of [
      [extra[0], 5],
      [extra[1], 1],
    ] as const) {
      const first = await listOf({ limit: '50' });
      expect(first.next_cursor).not.toBeNull();
      await rate(museumId as string, rating);
      await recomputeStats(p.worker);
      const rest = await walk({ limit: '50', cursor: first.next_cursor as string });
      const seen = [...first.items, ...rest].map((i) => i.id).filter((id) => id !== museumId);
      expect(seen.length).toBe(total - 1);
      expect(new Set(seen).size).toBe(total - 1);
    }
  }, 120_000);
});

describe('min_rating and kid_friendly', () => {
  let m395: Museum; // 20 ratings, mean 3.95, shown 4.0
  let m39: Museum; // 10 ratings, mean 3.9
  let kidOk: Museum; // 3 kid-friendly ratings of 4: the floor
  let kidFew: Museum; // 2 kid-friendly ratings of 5: below the floor
  let kidLow: Museum; // 3 kid-friendly ratings 4, 4, 3: mean 3.7
  let unrated: Museum;

  beforeAll(async () => {
    m395 = take();
    m39 = take();
    kidOk = take();
    kidFew = take();
    kidLow = take();
    unrated = take();
    const m395r = [3, ...Array(19).fill(4)];
    await rateMany(m395.id, m395r, m395r); // kid_friendly = rating: mean 3.95 over 20
    const m39r = [3, ...Array(9).fill(4)];
    await rateMany(m39.id, m39r);
    await rateMany(kidOk.id, [3, 3, 3], [4, 4, 4]);
    await rateMany(kidFew.id, [4, 4], [5, 5]);
    await rateMany(kidLow.id, [4, 4, 4], [4, 4, 3]);
    await recomputeStats(p.worker);
    await checkScores();
  }, 120_000);

  const ids = async (params: Record<string, string>) => (await walk({ limit: '50', ...params })).map((i) => i.id);

  it('min_rating compares the stored, rounded mean and needs a rating', async () => {
    const stats = await p.owner.query<{ rating_mean: number }>(
      'SELECT rating_mean FROM museum_stats WHERE museum_id = ANY($1)',
      [[m395.id, m39.id]],
    );
    expect(stats.rows.map((r) => r.rating_mean).sort()).toEqual([3.9, 4]);

    const four = await ids({ min_rating: '4' });
    expect(four).toContain(m395.id); // 3.95 shows as 4.0
    expect(four).not.toContain(m39.id);
    expect(four).not.toContain(unrated.id);
    const three = await ids({ min_rating: '3' });
    expect(three).toContain(m39.id);
    expect(three).not.toContain(unrated.id); // no rating at all
    for (const min of [1, 2, 3, 4, 5]) {
      const items = await walk({ limit: '50', min_rating: String(min) });
      expect(items.length).toBeGreaterThan(0);
      for (const i of items) {
        expect(i.rating_count).toBeGreaterThanOrEqual(1);
        expect(i.rating_mean).toBeGreaterThanOrEqual(min);
      }
      expect((await listOf({ min_rating: String(min), limit: '1' })).total).toBe(items.length);
    }
  }, 120_000);

  it('kid_friendly needs ASPECT_MIN ratings of the aspect and a mean of at least 4', async () => {
    expect(ASPECT_MIN).toBe(3);
    const kid = await ids({ kid_friendly: 'true' });
    expect(kid).toContain(kidOk.id);
    expect(kid).toContain(m395.id); // kid mean 3.95 shows as 4.0
    expect(kid).not.toContain(kidFew.id); // 2 ratings
    expect(kid).not.toContain(kidLow.id); // 3.7
    expect(kid).not.toContain(m39.id); // no kid ratings
    expect((await listOf({ kid_friendly: 'true', limit: '1' })).total).toBe(kid.length);
  });

  it('the filters combine, work with q, and the points share them', async () => {
    const both = await ids({ kid_friendly: 'true', min_rating: '4' });
    const four = new Set(await ids({ min_rating: '4' }));
    expect(both).toEqual((await ids({ kid_friendly: 'true' })).filter((id) => four.has(id)));
    expect(both).toContain(m395.id);
    expect(both).not.toContain(kidOk.id); // kid-friendly, but rated 3.0 overall
    for (const params of [{ min_rating: '4' }, { kid_friendly: 'true' }, { min_rating: '3', kid_friendly: 'true' }]) {
      const listed = (await walk({ limit: '50', ...params })).filter((i) => i.lat !== null && i.lon !== null);
      const points = await pointsOf(params);
      expect(points.sort()).toEqual(listed.map((i) => i.id).sort());
      expect(points.length).toBeGreaterThan(0);
    }
    // q mode applies the filters too
    const q = await walk({ q: 'museum', limit: '50', min_rating: '4' });
    for (const i of q) expect(i.rating_mean).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('items carry rating_mean null exactly when rating_count is 0', async () => {
    const items = await walk({ limit: '50' });
    expect(items.some((i) => i.rating_count === 0)).toBe(true);
    expect(items.some((i) => i.rating_count > 0)).toBe(true);
    for (const i of items) expect(i.rating_mean === null).toBe(i.rating_count === 0);
  });

  it('the detail shows an aspect mean from ASPECT_MIN ratings; near-me carries the rating', async () => {
    const ok = await getMuseumDetail(p.db, kidOk.slug);
    expect(ok?.rating_count).toBe(3);
    expect(ok?.rating_mean).toBe(3);
    expect(ok?.aspects.kid_friendly).toEqual({ mean: 4, count: 3 });
    expect(ok?.aspects.collection).toEqual({ mean: null, count: 0 });
    const few = await getMuseumDetail(p.db, kidFew.slug);
    expect(few?.aspects.kid_friendly).toEqual({ mean: null, count: 2 }); // below the floor: the count only
    const none = await getMuseumDetail(p.db, unrated.slug);
    expect(none).toMatchObject({ rating_count: 0, rating_mean: null });

    const near = await findNearest(p.db, { lat: kidOk.lat, lon: kidOk.lon, limit: 5 });
    expect(near.items.find((i) => i.id === kidOk.id)).toMatchObject({ rating_count: 3, rating_mean: 3 });
    for (const i of near.items) expect(i.rating_mean === null).toBe(i.rating_count === 0);
  });
});
