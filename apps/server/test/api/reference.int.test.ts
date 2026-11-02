import { ErrorBody, MkList, Provinces } from '@mjk/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.ts';
import { CACHE_PUBLIC } from '../../src/api/cache.ts';
import { mountMkList } from '../../src/api/routes/mk-list.ts';
import { mountProvinces } from '../../src/api/routes/provinces.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { currentMkList, listProvinces } from '../../src/museums/reference.ts';
import { type Harness, openHarness } from '../admin/harness.ts';

// GET /api/v1/provinces and /api/v1/mk-list, and the query functions as mjk_ssr (views only).

let h: Harness;
let owner: pg.Client;
let db: Db;
let ssr: Db;
let app: ReturnType<typeof buildApp>;
let ids: string[];

const get = (path: string) => app.request(`http://localhost${path}`);

beforeAll(async () => {
  h = await openHarness();
  owner = new pg.Client({ connectionString: h.db.urls.admin });
  await owner.connect();
  await owner.query(
    `INSERT INTO municipality (cbs_code, name, province_code)
     VALUES ('GM0363', 'Amsterdam', 'NL-NH'), ('GM0518', 'Den Haag', 'NL-ZH')`,
  );
  const pool = createPool('mjk_api', { DATABASE_URL: h.db.urls.mjk_api }, { max: 2 });
  const ssrPool = createPool('mjk_ssr', { DATABASE_URL: h.db.urls.mjk_ssr }, { max: 2 });
  if (typeof pool === 'string' || typeof ssrPool === 'string') throw new Error('pool');
  db = createDb(pool);
  ssr = createDb(ssrPool);
  app = buildApp({ db, logger: silentLogger, ping: async () => true }, (v1, deps) => {
    mountProvinces(v1, deps);
    mountMkList(v1, deps);
  });
  ids = await h.seed([
    { slug: 'one', name: 'One', status: 'participating' },
    { slug: 'two', name: 'Two', status: 'participating' },
    { slug: 'three', name: 'Three' },
    { slug: 'four', name: 'Four' },
  ]);
  const at = (id: string, code: string) =>
    h.api.query('UPDATE museum SET municipality_code = $2 WHERE id = $1', [id, code]);
  await at(ids[0] as string, 'GM0363');
  await at(ids[1] as string, 'GM0363');
  await at(ids[2] as string, 'GM0363');
  await at(ids[3] as string, 'GM0518');
});
afterAll(async () => {
  await db?.destroy();
  await ssr?.destroy();
  await owner?.end();
  await h?.close();
});

const counts = (p: Provinces) => Object.fromEntries(p.items.map((i) => [i.code, i.museum_count]));

describe('provinces', () => {
  it('lists 12 provinces ordered by code with counts of visible museums', async () => {
    const r = await get('/api/v1/provinces');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(CACHE_PUBLIC);
    const p = Provinces.parse(await r.json());
    const codes = p.items.map((i) => i.code);
    expect(codes).toHaveLength(12);
    expect(codes).toEqual([...codes].sort());
    expect(counts(p)).toMatchObject({ 'NL-NH': 3, 'NL-ZH': 1, 'NL-UT': 0 });
  });

  it('does not count a hidden museum', async () => {
    await h.api.query('UPDATE museum SET hidden = true WHERE id = $1', [ids[2]]);
    const p = Provinces.parse(await (await get('/api/v1/provinces')).json());
    expect(counts(p)['NL-NH']).toBe(2);
    expect((await listProvinces(ssr)).find((x) => x.code === 'NL-NH')?.museum_count).toBe(2);
    await h.api.query('UPDATE museum SET hidden = false WHERE id = $1', [ids[2]]);
  });

  it('refuses a query parameter', async () => {
    const r = await get('/api/v1/provinces?x=1');
    expect(r.status).toBe(400);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await r.json())).toEqual({ error: 'bad_request', fields: [] });
  });
});

describe('mk-list', () => {
  it('is null before the first published list', async () => {
    const r = await get('/api/v1/mk-list');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(CACHE_PUBLIC);
    expect(MkList.parse(await r.json())).toEqual({ list: null });
    expect(await currentMkList(ssr)).toBeNull();
  });

  it('then carries the date and N, which a hidden member does not change', async () => {
    expect((await h.admin('list', 'publish', '--date', '2026-11-01')).code).toBe(0);
    expect(MkList.parse(await (await get('/api/v1/mk-list')).json())).toEqual({
      list: { published_on: '2026-11-01', n: 2 },
    });
    await h.api.query('UPDATE museum SET hidden = true WHERE id = $1', [ids[0]]);
    expect(MkList.parse(await (await get('/api/v1/mk-list')).json())).toEqual({
      list: { published_on: '2026-11-01', n: 2 },
    });
    expect(await currentMkList(ssr)).toEqual({ published_on: '2026-11-01', n: 2 });
  });

  it('refuses a query parameter', async () => {
    expect((await get('/api/v1/mk-list?x=1')).status).toBe(400);
  });
});
