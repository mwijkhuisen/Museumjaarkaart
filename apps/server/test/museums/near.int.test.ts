import { ErrorBody, NearList } from '@mjk/contracts';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.ts';
import { mountMuseumsNear } from '../../src/api/routes/museums-near.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger, silentLogger } from '../../src/lib/log.ts';
import { NL_BOX } from '../../src/museums/fields.ts';
import { haversineMetres } from '../../src/museums/geo.ts';
import { findNearest } from '../../src/museums/near.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// GET /api/v1/museums/near (A§14, ADR-0015): the k nearest visible museums equal a brute-force
// haversine over the whole fixture set, in the same order. Distances within 1e-6 m count as ties
// (libm and V8 differ in the last ulp), and a tie group may be ordered either way.

const TIE_M = 1e-6;

type Row = { id: string; lat: number; lon: number };

let db: TestDb;
let cat: SeededCatalogue;
let apiDb: Db;
let ssrDb: Db;
let reader: pg.Client;
let app: ReturnType<typeof buildApp>;
let qualifying: Row[];
let byId: Map<string, Row>;
let forbidden: Set<string>;
let futureClosed: { id: string; closed_on: string };
let tempClosedId: string;
const clients: pg.Client[] = [];

const near = (lat: number | string, lon: number | string, limit?: number) =>
  app.request(
    `http://localhost/api/v1/museums/near?lat=${lat}&lon=${lon}${limit === undefined ? '' : `&limit=${limit}`}`,
  );
const grid = (n: number) => (n / 1000).toFixed(3);

async function login(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
}

function pool(role: 'mjk_api' | 'mjk_ssr', url: string) {
  const p = createPool(role, { DATABASE_URL: url }, { max: 4 });
  if (typeof p === 'string') throw new Error(p);
  return p;
}

/** Every qualifying museum, nearest first, ties by id (the brute-force answer). */
function brute(lat: number, lon: number): { id: string; d: number }[] {
  return qualifying
    .map((r) => ({ id: r.id, d: haversineMetres({ lat, lon }, r) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
}

/** The API's answer for a point equals the brute force: same distances, same museums up to ties. */
async function expectSameAsBrute(lat: number, lon: number, limit: number) {
  const r = await near(lat.toFixed(3), lon.toFixed(3), limit);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  const { items } = NearList.parse(await r.json());

  const expected = brute(lat, lon);
  const n = Math.min(limit, expected.length);
  expect(items.length).toBe(n);
  expect(new Set(items.map((i) => i.id)).size).toBe(n);

  const dist = new Map(expected.map((e) => [e.id, e.d]));
  const got = items.map((i) => dist.get(i.id));
  for (const [i, d] of got.entries()) {
    expect(d, `item ${i} is a qualifying museum`).toBeDefined();
    expect(Math.abs((d as number) - (expected[i]?.d as number))).toBeLessThanOrEqual(TIE_M);
  }
  // The museums strictly nearer than the k-th are all in; nothing beyond it is.
  const kth = expected[n - 1]?.d ?? 0;
  const ids = new Set(items.map((i) => i.id));
  for (const e of expected) if (e.d < kth - TIE_M) expect(ids.has(e.id), `nearer museum ${e.id} is in`).toBe(true);
  for (const d of got) expect(d as number).toBeLessThanOrEqual(kth + TIE_M);

  for (const [i, item] of items.entries()) {
    const row = byId.get(item.id) as Row;
    expect([item.lat, item.lon]).toEqual([row.lat, row.lon]);
    const d = dist.get(item.id) as number;
    const diff = Math.abs(item.distance_m - Math.round(d));
    expect(diff === 0 || (diff === 1 && Math.abs((d % 1) - 0.5) < TIE_M), `distance_m of item ${i}`).toBe(true);
    const next = items[i + 1];
    // Exactly equal coordinates are exactly equal distances: the tie breaks by id.
    if (next !== undefined && next.lat === item.lat && next.lon === item.lon) expect(item.id < next.id).toBe(true);
  }
  return items;
}

beforeAll(async () => {
  db = await createMigratedDb();
  cat = await seedCatalogue(db);
  apiDb = createDb(pool('mjk_api', db.urls.mjk_api));
  ssrDb = createDb(pool('mjk_ssr', db.urls.mjk_ssr));
  reader = await login(db.urls.mjk_api);
  app = buildApp({ db: apiDb, logger: silentLogger, ping: async () => true }, (v1, deps) => mountMuseumsNear(v1, deps));

  // The database's own current_date decides who is permanently closed.
  const q = await reader.query<Row>(
    'SELECT id, lat, lon FROM pub_museum WHERE lat IS NOT NULL AND (closed_on IS NULL OR closed_on > current_date)',
  );
  qualifying = q.rows;
  byId = new Map(qualifying.map((r) => [r.id, r]));
  const out = await reader.query<{ id: string }>(
    'SELECT id FROM museum WHERE hidden OR lat IS NULL OR closed_on <= current_date',
  );
  forbidden = new Set(out.rows.map((r) => r.id));
  const future = await reader.query<{ id: string; closed_on: string }>(
    'SELECT id, closed_on::text AS closed_on FROM museum WHERE closed_on > current_date AND NOT hidden AND lat IS NOT NULL',
  );
  expect(future.rows.length).toBe(1);
  futureClosed = future.rows[0] as { id: string; closed_on: string };
  const temp = await reader.query<{ id: string }>(
    'SELECT id FROM museum WHERE temp_closed AND NOT hidden AND lat IS NOT NULL AND closed_on IS NULL LIMIT 1',
  );
  tempClosedId = (temp.rows[0] as { id: string }).id;
}, 180_000);

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await apiDb?.destroy();
  await ssrDb?.destroy();
  await db?.drop();
});

describe('the fixture set', () => {
  it('has hidden, closed and coordinate-less museums for the sweep, and enough to compare', () => {
    expect(cat.hiddenIds.length).toBeGreaterThanOrEqual(25);
    expect(forbidden.size).toBeGreaterThan(cat.hiddenIds.length);
    expect(qualifying.length).toBeGreaterThan(1000);
    for (const id of forbidden) expect(byId.has(id)).toBe(false);
  });
});

describe('GET /museums/near equals the brute force', () => {
  it('for random points on the 3-decimal grid inside NL_BOX and k from 1 to 50', async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: Math.round(NL_BOX.latMin * 1000), max: Math.round(NL_BOX.latMax * 1000) }),
        fc.integer({ min: Math.round(NL_BOX.lonMin * 1000), max: Math.round(NL_BOX.lonMax * 1000) }),
        fc.integer({ min: 1, max: 50 }),
        async (la, lo, k) => {
          runs++;
          await expectSameAsBrute(Number(grid(la)), Number(grid(lo)), k);
        },
      ),
      { numRuns: 200 },
    );
    expect(runs).toBeGreaterThanOrEqual(200);
  }, 120_000);

  it('for points in the middle of the dense areas (the nearest museums are close and many)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 51_900, max: 52_400 }),
        fc.integer({ min: 4_300, max: 5_200 }),
        fc.integer({ min: 1, max: 50 }),
        async (la, lo, k) => {
          await expectSameAsBrute(Number(grid(la)), Number(grid(lo)), k);
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);

  const corners = [NL_BOX.latMin, NL_BOX.latMax].flatMap((lat) =>
    [NL_BOX.lonMin, NL_BOX.lonMax].map((lon) => [lat, lon]),
  );
  const fixed: [string, number, number][] = [
    ['the point of the equal coordinates (52.1, 5.1)', 52.1, 5.1],
    ['the midpoint of the first mirrored pair', 52.0, 5.0],
    ['the midpoint of the second mirrored pair', 52.5, 6.0],
    ['a point in the North Sea', 53.7, 4.0],
    ['the middle of the Wadden Sea', 53.4, 5.5],
    ...corners.map(([lat, lon], i): [string, number, number] => [
      `corner ${i + 1} of NL_BOX`,
      lat as number,
      lon as number,
    ]),
  ];
  it.each(fixed)(
    'at %s, for every k that matters',
    async (_name, lat, lon) => {
      for (const k of [1, 2, 3, 4, 5, 20, 50]) await expectSameAsBrute(lat, lon, k);
    },
    60_000,
  );

  it('breaks exact ties by id: the three museums at the equal coordinates come first, in id order', async () => {
    const { lat, lon, ids } = cat.equalCoordinates;
    expect([lat, lon]).toEqual([52.1, 5.1]);
    const items = await expectSameAsBrute(lat, lon, 20);
    expect(items.slice(0, ids.length).map((i) => i.id)).toEqual([...ids].sort());
    expect(items.slice(0, ids.length).map((i) => i.distance_m)).toEqual(ids.map(() => 0));
  });

  it('has a default limit of 20', async () => {
    const body = NearList.parse(await (await near('52.100', '5.100')).json());
    expect(body.items.length).toBe(20);
  });

  it('never returns a hidden, permanently closed or coordinate-less museum, even right next to one', async () => {
    const rows = await reader.query<{ id: string; lat: number; lon: number }>(
      'SELECT id, lat, lon FROM museum WHERE lat IS NOT NULL AND (hidden OR closed_on <= current_date)',
    );
    expect(rows.rows.length).toBeGreaterThan(cat.hiddenIds.length - 1);
    for (const r of rows.rows) {
      const items = await expectSameAsBrute(Math.round(r.lat * 1000) / 1000, Math.round(r.lon * 1000) / 1000, 50);
      for (const i of items) expect(forbidden.has(i.id)).toBe(false);
    }
  }, 120_000);

  it('keeps a museum that closes in the future, and a temporarily closed one, with their flags', async () => {
    const f = byId.get(futureClosed.id) as Row;
    const items = await expectSameAsBrute(Math.round(f.lat * 1000) / 1000, Math.round(f.lon * 1000) / 1000, 5);
    const hit = items.find((i) => i.id === futureClosed.id);
    expect(hit?.closed_on).toBe(futureClosed.closed_on);
    expect(hit?.distance_m).toBeLessThan(100);

    const t = byId.get(tempClosedId) as Row;
    const temp = await expectSameAsBrute(Math.round(t.lat * 1000) / 1000, Math.round(t.lon * 1000) / 1000, 5);
    expect(temp.find((i) => i.id === tempClosedId)?.temp_closed).toBe(true);
  });
});

describe('errors and headers', () => {
  const bad = async (qs: string, fields: string[]) => {
    const r = await app.request(`http://localhost/api/v1/museums/near${qs}`);
    expect(r.status, qs).toBe(400);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await r.json())).toEqual({ error: 'bad_request', fields });
  };

  it('answers 400 for four decimals, a point outside NL_BOX, a missing or repeated value, or another parameter', async () => {
    await bad('?lat=52.1234&lon=5.1', ['lat']);
    await bad('?lat=52.1&lon=5.1234', ['lon']);
    await bad('?lat=52.1234&lon=5.1234', ['lat', 'lon']);
    await bad('?lat=50.699&lon=5.1', ['lat']);
    await bad('?lat=53.701&lon=5.1', ['lat']);
    await bad('?lat=52.1&lon=3.199', ['lon']);
    await bad('?lat=52.1&lon=7.301', ['lon']);
    await bad('?lat=0&lon=0', ['lat', 'lon']);
    await bad('?lat=abc&lon=5.1', ['lat']);
    await bad('?lat=52.1', ['lon']);
    await bad('?lon=5.1', ['lat']);
    await bad('', ['lat', 'lon']);
    await bad('?lat=52.1&lat=52.2&lon=5.1', ['lat']);
    await bad('?lat=52.1&lon=5.1&lon=5.2', ['lon']);
    await bad('?lat=52.1&lon=5.1&radius=5', []);
    await bad('?lat=52.1&lon=5.1&limit=0', ['limit']);
    await bad('?lat=52.1&lon=5.1&limit=51', ['limit']);
    await bad("?lat=52.1&lon=5.1&limit=1'", ['limit']);
  });

  it('accepts the corners of NL_BOX and limits 1 and 50', async () => {
    for (const [lat, lon] of [
      ['50.7', '3.2'],
      ['53.7', '7.3'],
    ] as const) {
      expect((await near(lat, lon, 1)).status).toBe(200);
      expect(NearList.parse(await (await near(lat, lon, 50)).json()).items.length).toBe(50);
    }
  });

  it('answers 200 with private, no-store and a body that parses its contract', async () => {
    const r = await near('52.372', '4.894', 3);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(NearList.parse(await r.json()).items.length).toBe(3);
  });
});

describe('the request log (invariant 8)', () => {
  it('logs the route pattern and never the coordinates', async () => {
    const { logger, lines } = memoryLogger('api');
    const logged = buildApp({ db: apiDb, logger, ping: async () => true }, (v1, deps) => mountMuseumsNear(v1, deps));
    const r = await logged.request('http://localhost/api/v1/museums/near?lat=52.123&lon=4.567');
    expect(r.status).toBe(200);
    const bad = await logged.request('http://localhost/api/v1/museums/near?lat=52.1234&lon=4.5678');
    expect(bad.status).toBe(400);
    expect(lines().map((l) => l.route)).toEqual(['/api/v1/museums/near', '/api/v1/museums/near']);
    expect(lines().map((l) => l.status)).toEqual([200, 400]);
    const text = JSON.stringify(lines());
    for (const leak of ['52.123', '4.567', '52.12', '4.56', '52.1234', '4.5678']) expect(text).not.toContain(leak);
  });
});

describe('the search itself', () => {
  it('runs as mjk_ssr (views only) and agrees with the api', async () => {
    const viaApi = NearList.parse(await (await near('52.372', '4.894', 10)).json());
    const { items, rounds } = await findNearest(ssrDb, { lat: 52.372, lon: 4.894, limit: 10 });
    expect(rounds).toBeGreaterThanOrEqual(1);
    expect(NearList.parse({ items })).toEqual(viaApi);
  });

  it('is one round in a dense place and at most 9 anywhere in NL_BOX', async () => {
    const histogram = new Map<number, number>();
    let seen = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: Math.round(NL_BOX.latMin * 1000), max: Math.round(NL_BOX.latMax * 1000) }),
        fc.integer({ min: Math.round(NL_BOX.lonMin * 1000), max: Math.round(NL_BOX.lonMax * 1000) }),
        fc.integer({ min: 1, max: 50 }),
        async (la, lo, limit) => {
          const { rounds } = await findNearest(apiDb, { lat: Number(grid(la)), lon: Number(grid(lo)), limit });
          histogram.set(rounds, (histogram.get(rounds) ?? 0) + 1);
          seen++;
          expect(rounds).toBeGreaterThanOrEqual(1);
          expect(rounds).toBeLessThanOrEqual(9);
        },
      ),
      { numRuns: 300 },
    );
    console.info(
      `near rounds over ${seen} random queries: ${JSON.stringify([...histogram].sort((a, b) => a[0] - b[0]))}`,
    );
    const amsterdam = await findNearest(apiDb, { lat: 52.372, lon: 4.894, limit: 1 });
    expect(amsterdam.rounds).toBe(1);
    const sea = await findNearest(apiDb, { lat: 53.7, lon: 3.2, limit: 50 });
    expect(sea.items.length).toBe(50);
    console.info(`near rounds in the sea corner with limit 50: ${sea.rounds}`);
  }, 120_000);
});

describe('fewer museums than the limit', () => {
  it('returns all of them once the box holds NL_BOX', async () => {
    const small = await createMigratedDb();
    const owner = new pg.Client({ connectionString: small.urls.mjk_api });
    let d: Db | undefined;
    try {
      await owner.connect();
      const rows: [string, number | null, number | null, string | null][] = [
        ['a', 52.0, 5.0, null],
        ['b', 53.6, 7.2, null],
        ['c', 50.8, 3.3, null],
        ['gone', 52.001, 5.001, '2020-01-01'],
        ['nowhere', null, null, null],
      ];
      for (const [slug, lat, lon, closed] of rows)
        await owner.query('INSERT INTO museum (slug, name, lat, lon, closed_on) VALUES ($1, $1, $2, $3, $4)', [
          slug,
          lat,
          lon,
          closed,
        ]);
      d = createDb(pool('mjk_api', small.urls.mjk_api));
      const { items, rounds } = await findNearest(d, { lat: 52.0, lon: 5.0, limit: 50 });
      expect(items.map((i) => i.slug)).toEqual(['a', 'c', 'b']);
      expect(items[0]?.distance_m).toBe(0);
      expect(rounds).toBeGreaterThan(1);
      expect(NearList.parse({ items }).items.length).toBe(3);
    } finally {
      await owner.end().catch(() => {});
      await d?.destroy();
      await small.drop();
    }
  }, 60_000);
});
