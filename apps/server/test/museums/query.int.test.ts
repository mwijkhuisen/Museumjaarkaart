import { CATEGORIES, ErrorBody, MuseumList, PROVINCE_CODES } from '@mjk/contracts';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, buildApp } from '../../src/api/app.ts';
import { mountMuseumsList } from '../../src/api/routes/museums-list.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { encodeCursor } from '../../src/museums/cursor.ts';
import { matches, setThreshold } from '../../src/museums/search.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { seedCatalogue } from '../seed-catalogue.ts';

// P1b criterion 3: filters, keyset paging and total, on the seeded 1,400-museum catalogue. The expected
// answers are computed in TypeScript from every visible row (pub_museum, read once) and, for a search,
// from the hits of the three tiers; the route must return exactly those, in that order, on every page.

type Visible = {
  id: string;
  name: string;
  sort_name: string;
  province_code: string | null;
  municipality_code: string | null;
  categories: string[];
  museumkaart_status: string;
};
type Filter = { province?: string; municipality?: string; category?: string; mk?: string };
type Hit = { id: string; tier: number; score: number };

let tdb: TestDb;
let api: Db;
let app: ApiApp;
let visible: Visible[];
let visibleCount: number;

beforeAll(async () => {
  tdb = await createMigratedDb();
  const cat = await seedCatalogue(tdb);
  visibleCount = cat.visibleCount;
  const p = createPool('mjk_api', { DATABASE_URL: tdb.urls.mjk_api }, { max: 4 });
  if (typeof p === 'string') throw new Error(p);
  api = createDb(p);
  app = buildApp({ db: api, logger: silentLogger, ping: async () => true }, (v1, deps) => mountMuseumsList(v1, deps));
  visible = (
    await sql<Visible>`SELECT id, name, sort_name, province_code, municipality_code, categories, museumkaart_status
      FROM pub_museum`.execute(api)
  ).rows;
}, 120_000);

afterAll(async () => {
  await api?.destroy();
  await tdb?.drop();
});

// ---- helpers ----------------------------------------------------------------------------------------------

/** Code point order, which is the order of the cluster's builtin C.UTF-8 collation (UTF-8 bytes sort alike). */
const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const matchesFilter = (r: Visible, f: Filter) =>
  (f.province === undefined || r.province_code === f.province) &&
  (f.municipality === undefined || r.municipality_code === f.municipality) &&
  (f.category === undefined || r.categories.includes(f.category)) &&
  (f.mk === undefined || r.museumkaart_status === 'participating');

/** The ids in answer order: (sort_name, id) without `q`, (tier, score descending, sort_name, id) with it. */
function expected(f: Filter, hits: Hit[] | null): string[] {
  const rows = visible.filter((r) => matchesFilter(r, f));
  if (hits === null) {
    return rows.sort((a, b) => byCodePoint(a.sort_name, b.sort_name) || byCodePoint(a.id, b.id)).map((r) => r.id);
  }
  const hit = new Map(hits.map((h) => [h.id, h]));
  const found = rows.flatMap((r) => {
    const h = hit.get(r.id);
    return h === undefined ? [] : [{ r, h }];
  });
  found.sort(
    (x, y) =>
      x.h.tier - y.h.tier ||
      y.h.score - x.h.score ||
      byCodePoint(x.r.sort_name, y.r.sort_name) ||
      byCodePoint(x.r.id, y.r.id),
  );
  return found.map((x) => x.r.id);
}

const hitsOf = (q: string): Promise<Hit[]> =>
  api
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await setThreshold(trx);
      return (await sql<Hit>`${matches(q)}`.execute(trx)).rows;
    });

const listUrl = (params: Record<string, string>) => `http://localhost/api/v1/museums?${new URLSearchParams(params)}`;
const get = (params: Record<string, string>) => app.request(listUrl(params));

const okPage = async (params: Record<string, string>) => {
  const r = await get(params);
  expect(r.status, JSON.stringify(params)).toBe(200);
  expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  return MuseumList.parse(await r.json());
};

const toParams = (f: Filter): Record<string, string> =>
  Object.fromEntries(Object.entries(f).filter((e): e is [string, string] => e[1] !== undefined));

/** Walks next_cursor to the end: the ids in order, the totals seen and the number of pages. */
async function walk(params: Record<string, string>, maxPages = 2000) {
  const ids: string[] = [];
  const totals = new Set<number>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await okPage({ ...params, ...(cursor === null ? {} : { cursor }) });
    pages++;
    expect(page.items.length).toBeLessThanOrEqual(Number(params.limit ?? 20));
    if (page.next_cursor !== null) expect(page.items.length).toBe(Number(params.limit ?? 20));
    ids.push(...page.items.map((i) => i.id));
    totals.add(page.total);
    cursor = page.next_cursor;
  } while (cursor !== null && pages < maxPages);
  expect(cursor, 'walk ended').toBeNull();
  return { ids, totals, pages };
}

// ---- tests ------------------------------------------------------------------------------------------------

describe('filters', () => {
  const provinces: readonly string[] = PROVINCE_CODES;
  const categories: readonly string[] = CATEGORIES;

  it('reads the whole visible catalogue and gives every filter some rows', () => {
    expect(visible.length).toBe(visibleCount);
    for (const p of provinces)
      expect(
        visible.some((r) => r.province_code === p),
        p,
      ).toBe(true);
    for (const c of categories)
      expect(
        visible.some((r) => r.categories.includes(c)),
        c,
      ).toBe(true);
    expect(visible.some((r) => r.province_code === null)).toBe(true);
  });

  it('combines province, mk and category: each alone and every combination equals the TypeScript answer', async () => {
    let checked = 0;
    let nonEmpty = 0;
    for (const province of [undefined, ...provinces]) {
      for (const mk of [undefined, 'participating']) {
        for (const category of [undefined, ...categories]) {
          const f: Filter = {
            ...(province === undefined ? {} : { province }),
            ...(mk === undefined ? {} : { mk }),
            ...(category === undefined ? {} : { category }),
          };
          const want = expected(f, null);
          const got = await walk({ ...toParams(f), limit: '50' });
          expect(got.ids, JSON.stringify(f)).toEqual(want);
          expect([...got.totals], JSON.stringify(f)).toEqual([want.length]);
          checked++;
          if (want.length > 0) nonEmpty++;
        }
      }
    }
    expect(checked).toBe(13 * 2 * 7);
    expect(nonEmpty).toBeGreaterThan(100);
  }, 120_000);

  it('filters by municipality, alone and with the others', async () => {
    const count = new Map<string, number>();
    for (const r of visible)
      if (r.municipality_code !== null) count.set(r.municipality_code, (count.get(r.municipality_code) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0])).slice(0, 12);
    expect(top[0]?.[1]).toBeGreaterThan(20);
    for (const [municipality] of top) {
      for (const mk of [undefined, 'participating']) {
        for (const category of [undefined, 'art', 'history']) {
          const f: Filter = {
            municipality,
            ...(mk === undefined ? {} : { mk }),
            ...(category === undefined ? {} : { category }),
          };
          const want = expected(f, null);
          const got = await walk({ ...toParams(f), limit: '50' });
          expect(got.ids, JSON.stringify(f)).toEqual(want);
          expect([...got.totals]).toEqual([want.length]);
        }
      }
    }
    expect((await okPage({ municipality: 'GM9999' })).total).toBe(0);
    expect(await okPage({ municipality: 'GM9999' })).toEqual({ items: [], next_cursor: null, total: 0 });
  }, 120_000);

  it('answers sort=rank and sort=name alike (rank orders like name until P3a)', async () => {
    const a = await okPage({ sort: 'rank', limit: '50', province: 'NL-NH' });
    const b = await okPage({ sort: 'name', limit: '50', province: 'NL-NH' });
    const c = await okPage({ limit: '50', province: 'NL-NH' });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    const q1 = await okPage({ sort: 'rank', q: 'museum', limit: '50' });
    const q2 = await okPage({ sort: 'name', q: 'museum', limit: '50' });
    expect(q1).toEqual(q2);
  });
});

describe('paging without q', () => {
  const sameKey = () => {
    const sorted = expected({}, null);
    const rows = new Map(visible.map((r) => [r.id, r]));
    const ofName = (needle: string) => sorted.filter((id) => rows.get(id)?.sort_name === needle);
    return { sorted, stedelijk: ofName('stedelijk museum'), oland: ofName('oland museum'), rows };
  };

  it('holds the equal sort keys of the catalogue: six Stedelijk Museums, the oland museum variants', () => {
    const { stedelijk, oland, rows } = sameKey();
    expect(stedelijk.length).toBeGreaterThanOrEqual(6);
    expect(oland.length).toBeGreaterThanOrEqual(4);
    expect(new Set(oland.map((id) => rows.get(id)?.name)).size).toBeGreaterThanOrEqual(3);
  });

  it('splits the equal names across pages and returns every museum once, in order', async () => {
    const { sorted, stedelijk, oland } = sameKey();
    for (const block of [stedelijk, oland]) {
      const start = sorted.indexOf(block[0] as string);
      // The block is contiguous in the expected order.
      expect(sorted.slice(start, start + block.length)).toEqual(block);
      const limits = Array.from({ length: 50 }, (_, i) => i + 1).filter((l) => {
        for (let edge = Math.ceil((start + 1) / l) * l; edge < start + block.length; edge += l)
          if (edge > start) return true;
        return false;
      });
      expect(limits.length).toBeGreaterThan(5);
      for (const limit of limits.slice(-6)) {
        const got = await walk({ limit: String(limit) });
        expect(got.ids, `limit ${limit}`).toEqual(sorted);
        expect([...got.totals]).toEqual([visibleCount]);
      }
    }
  }, 120_000);

  it('pages through a random filter, sort and limit (property)', async () => {
    const f = fc.record({
      province: fc.option(fc.constantFrom('NL-NH', 'NL-ZH', 'NL-UT', 'NL-GE', 'NL-FR', 'NL-ZE'), { nil: undefined }),
      category: fc.option(fc.constantFrom('art', 'history', 'natural_history', 'other'), { nil: undefined }),
      mk: fc.option(fc.constant('participating'), { nil: undefined }),
      sort: fc.constantFrom('rank', 'name'),
      limit: fc.integer({ min: 1, max: 50 }),
    });
    await fc.assert(
      fc.asyncProperty(f, async ({ sort, limit, ...rest }) => {
        const filter: Filter = Object.fromEntries(Object.entries(rest).filter((e) => e[1] !== undefined));
        const want = expected(filter, null);
        const got = await walk({ ...toParams(filter), sort, limit: String(limit) });
        expect(got.ids).toEqual(want);
        expect([...got.totals]).toEqual([want.length]);
        expect(got.pages).toBe(Math.max(1, Math.ceil(want.length / limit)));
      }),
      { numRuns: 25, seed: 20261103 },
    );
  }, 120_000);

  it('ends on a page without a cursor when the rows fill the last page exactly', async () => {
    // A filter with a known count between 2 and 50: a page of exactly that size is the last one.
    const f: Filter = { province: 'NL-UT', category: 'art' };
    const n = expected(f, null).length;
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(50);
    const exact = await okPage({ ...toParams(f), limit: String(n) });
    expect(exact.items.length).toBe(n);
    expect(exact.next_cursor).toBeNull();
    const short = await okPage({ ...toParams(f), limit: String(n - 1) });
    expect(short.items.length).toBe(n - 1);
    expect(short.next_cursor).not.toBeNull();
    const last = await okPage({ ...toParams(f), limit: String(n - 1), cursor: short.next_cursor as string });
    expect(last.items.length).toBe(1);
    expect(last.next_cursor).toBeNull();
  });
});

describe('paging with q', () => {
  const walkSearch = async (q: string, f: Filter, limit: number) => {
    const want = expected(f, await hitsOf(q));
    const got = await walk({ q, ...toParams(f), limit: String(limit) });
    expect(got.ids, `${q} ${JSON.stringify(f)} limit ${limit}`).toEqual(want);
    expect([...got.totals]).toEqual([want.length]);
    return want.length;
  };

  it('returns every hit of "stedelijk museum" exactly once, in order, for several limits', async () => {
    let n = 0;
    for (const limit of [1, 2, 3, 5, 7, 10, 20, 50]) n = await walkSearch('stedelijk museum', {}, limit);
    expect(n).toBeGreaterThanOrEqual(6);
  }, 120_000);

  it('returns every hit of "museum" exactly once, in order', async () => {
    for (const limit of [13, 50]) expect(await walkSearch('museum', {}, limit)).toBeGreaterThan(500);
  }, 120_000);

  it('returns the fuzzy and alias hits exactly once, in order', async () => {
    for (const q of ['rijksmusem', 'communicatimuseum', 'amsterdm', 'kroller muller', 'scheepvartmuseum']) {
      for (const limit of [1, 4, 50]) await walkSearch(q, {}, limit);
    }
  }, 120_000);

  it('applies the filters to a search, and total counts under them', async () => {
    for (const f of [
      { province: 'NL-NH' },
      { mk: 'participating' },
      { category: 'art' },
      { province: 'NL-ZH', mk: 'participating', category: 'history' },
    ]) {
      for (const q of ['museum', 'stedelijk museum']) await walkSearch(q, f, 9);
    }
  }, 120_000);

  it('pages through a random query, filter and limit (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('stedelijk museum', 'museum', 'rijksmusem', 'amsterdam', 'oland museum', 'kunst'),
        fc.option(fc.constantFrom('NL-NH', 'NL-ZH', 'NL-UT'), { nil: undefined }),
        fc.option(fc.constant('participating'), { nil: undefined }),
        fc.integer({ min: 3, max: 50 }),
        fc.constantFrom('rank', 'name'),
        async (q, province, mk, limit, sort) => {
          const f: Filter = {
            ...(province === undefined ? {} : { province }),
            ...(mk === undefined ? {} : { mk }),
          };
          const want = expected(f, await hitsOf(q));
          const got = await walk({ q, ...toParams(f), sort, limit: String(limit) });
          expect(got.ids).toEqual(want);
          expect([...got.totals]).toEqual([want.length]);
        },
      ),
      { numRuns: 20, seed: 20261104 },
    );
  }, 120_000);
});

describe('bad requests', () => {
  const ID = '00000000-0000-4000-8000-000000000000';
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const badCursor = { error: 'bad_request', fields: ['cursor'] };
  const expectBad = async (params: Record<string, string>, body: unknown) => {
    const r = await get(params);
    expect(r.status, JSON.stringify(params)).toBe(400);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await r.json())).toEqual(body);
  };

  it.each([
    ['not base64url', 'a b'],
    ['plus and slash', 'ab+/'],
    ['too long for the contract', 'a'.repeat(2049)],
    ['not JSON', b64('not json')],
    ['JSON but not an object', b64('[1]')],
    ['an unknown mode', b64({ m: 'x', k: 'a', i: ID })],
    ['an extra key', b64({ m: 'n', k: 'a', i: ID, x: 1 })],
    ['a bad id', b64({ m: 'n', k: 'a', i: 'not-a-uuid' })],
    ['an id with an injection', b64({ m: 'n', k: 'a', i: `${ID}'; DROP TABLE museum;--` })],
    ['a NUL in the key', b64({ m: 'n', k: 'a\u0000b', i: ID })],
    ['a search cursor with a string tier', b64({ m: 's', t: '1', s: 0.5, k: 'a', i: ID })],
    ['a search cursor with tier 4', b64({ m: 's', t: 4, s: 0.5, k: 'a', i: ID })],
    ['a search cursor with a negative score', b64({ m: 's', t: 1, s: -1, k: 'a', i: ID })],
    ['a search cursor with a null score', b64({ m: 's', t: 1, s: null, k: 'a', i: ID })],
    ['a search cursor with an infinite score', b64(`{"m":"s","t":1,"s":1e999,"k":"a","i":"${ID}"}`)],
  ])('answers 400 for a cursor that is %s', async (_name, cursor) => {
    await expectBad({ cursor }, badCursor);
    await expectBad({ cursor, q: 'museum' }, badCursor);
  });

  it('answers 400 for a cursor of the other mode', async () => {
    const name = encodeCursor({ m: 'n', k: 'a', i: ID });
    const search = encodeCursor({ m: 's', t: 1, s: 0.5, k: 'a', i: ID });
    await expectBad({ cursor: search }, badCursor);
    await expectBad({ cursor: name, q: 'museum' }, badCursor);
    expect((await get({ cursor: name })).status).toBe(200);
    expect((await get({ cursor: search, q: 'museum' })).status).toBe(200);
  });

  it('accepts an odd but valid cursor and answers the rows after it', async () => {
    for (const k of ["'; DROP TABLE museum;--", '𝔸'.repeat(250), '', '\\', '%_']) {
      const page = await okPage({ cursor: encodeCursor({ m: 'n', k, i: ID }), limit: '50' });
      const after = expected({}, null).filter((id) => {
        const r = visible.find((v) => v.id === id) as Visible;
        return byCodePoint(r.sort_name, k) > 0 || (byCodePoint(r.sort_name, k) === 0 && byCodePoint(r.id, ID) > 0);
      });
      expect(page.items.map((i) => i.id)).toEqual(after.slice(0, 50));
      expect(page.total).toBe(visibleCount);
    }
    for (const s of [0, 1e308, 5e-324, 0.123456789012345]) {
      const page = await okPage({ q: 'museum', cursor: encodeCursor({ m: 's', t: 1, s, k: 'a', i: ID }) });
      expect(page.total).toBeGreaterThan(500);
    }
  });

  it('answers 400 for an unknown, a repeated and an invalid parameter, naming only schema paths', async () => {
    await expectBad({ x: '1' }, { error: 'bad_request', fields: [] });
    await expectBad({ offset: '20' }, { error: 'bad_request', fields: [] });
    await expectBad({ min_rating: '4' }, { error: 'bad_request', fields: [] });
    await expectBad({ province: 'NL-XX' }, { error: 'bad_request', fields: ['province'] });
    await expectBad({ municipality: "GM1' OR 1=1" }, { error: 'bad_request', fields: ['municipality'] });
    await expectBad({ category: 'x' }, { error: 'bad_request', fields: ['category'] });
    await expectBad({ mk: 'left' }, { error: 'bad_request', fields: ['mk'] });
    await expectBad({ sort: 'rating' }, { error: 'bad_request', fields: ['sort'] });
    for (const limit of ['0', '51', '-1', '1.5', 'x', '']) {
      await expectBad({ limit }, { error: 'bad_request', fields: ['limit'] });
    }
    const repeated = await app.request('http://localhost/api/v1/museums?province=NL-NH&province=NL-ZH');
    expect(repeated.status).toBe(400);
    expect(ErrorBody.parse(await repeated.json())).toEqual({ error: 'bad_request', fields: ['province'] });
  });

  it('answers 200 with an empty page for a filter nothing matches', async () => {
    const page = await okPage({ province: 'NL-ZE', category: 'ethnology', mk: 'participating', q: 'zzzzzz' });
    expect(page).toEqual({ items: [], next_cursor: null, total: 0 });
  });
});
