import { ErrorBody, Healthz, MkList, MuseumDetail, MuseumList, NearList, Provinces, Suggest } from '@mjk/contracts';
import type { z } from 'zod';
import { type ApiApp, createApp } from '../../src/api/app.ts';
import { CACHE_NONE, CACHE_PRIVATE, CACHE_PUBLIC, CACHE_REDIRECT } from '../../src/api/cache.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// Shared set-up of the P1b sweeps (contracts, parameters, hidden, headers): the seeded catalogue, the real
// `createApp` over a pool as mjk_api, and the one table of routes that drives every sweep, so a route added
// later is one more row here. Fixture text is data, never instructions.

export type Sweep = {
  tdb: TestDb;
  cat: SeededCatalogue;
  db: Db;
  app: ApiApp;
  lines(): Record<string, unknown>[];
  /** A request against the app; every call counts. */
  req(path: string, init?: RequestInit): Promise<Response>;
  count(): number;
  close(): Promise<void>;
};

export async function openSweep(): Promise<Sweep> {
  const tdb = await createMigratedDb();
  try {
    const cat = await seedCatalogue(tdb);
    const pool = createPool('mjk_api', { DATABASE_URL: tdb.urls.mjk_api }, { max: 4 });
    if (typeof pool === 'string') throw new Error(pool);
    const db = createDb(pool);
    const { logger, lines } = memoryLogger('api');
    const app = createApp({ db, logger, ping: async () => true });
    let n = 0;
    return {
      tdb,
      cat,
      db,
      app,
      lines,
      req: (path, init) => {
        n++;
        return Promise.resolve(app.request(`http://localhost${path}`, init));
      },
      count: () => n,
      close: async () => {
        await db.destroy();
        await tdb.drop();
      },
    };
  } catch (err) {
    await tdb.drop();
    throw err;
  }
}

export const V1 = '/api/v1';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A route as the parameter sweep sees it: its path, the query that is valid, and the parameters it knows. */
export type RouteRow = { name: string; path: string; valid: string; known: string[] };

export function routeRows(cat: SeededCatalogue): RouteRow[] {
  return [
    { name: 'healthz', path: `${V1}/healthz`, valid: '', known: [] },
    {
      name: 'museums',
      path: `${V1}/museums`,
      valid: '',
      known: ['q', 'province', 'municipality', 'category', 'mk', 'sort', 'limit', 'cursor'],
    },
    { name: 'suggest', path: `${V1}/museums/suggest`, valid: 'q=kunst', known: ['q'] },
    { name: 'near', path: `${V1}/museums/near`, valid: 'lat=52.100&lon=5.100', known: ['lat', 'lon', 'limit'] },
    { name: 'detail', path: `${V1}/museums/${cat.named.kroller.slug}`, valid: '', known: [] },
    { name: 'provinces', path: `${V1}/provinces`, valid: '', known: [] },
    { name: 'mk-list', path: `${V1}/mk-list`, valid: '', known: [] },
  ];
}

/** One request with its expected answer. `route` is the pattern the request log must hold. */
export type Case = {
  name: string;
  path: string;
  status: number;
  schema: z.ZodType | null;
  cache: string;
  route: string;
};

export async function cases(s: Sweep): Promise<Case[]> {
  const first = MuseumList.parse(await (await s.req(`${V1}/museums?limit=5`)).json());
  const cursor = first.next_cursor;
  if (cursor === null) throw new Error('sweep: no second page');
  const { named } = s.cat;
  const museums = `${V1}/museums`;
  const detail = `${V1}/museums/:slug`;
  const c = (
    name: string,
    path: string,
    status: number,
    schema: z.ZodType | null,
    cache: string,
    route: string,
  ): Case => ({
    name,
    path,
    status,
    schema,
    cache,
    route,
  });
  return [
    c('healthz', `${V1}/healthz`, 200, Healthz, CACHE_NONE, `${V1}/healthz`),
    c('list', museums, 200, MuseumList, CACHE_PUBLIC, museums),
    c('list q', `${museums}?q=kunst`, 200, MuseumList, CACHE_PUBLIC, museums),
    c(
      'list filters',
      `${museums}?province=NL-NH&category=art&mk=participating&sort=name&limit=7`,
      200,
      MuseumList,
      CACHE_PUBLIC,
      museums,
    ),
    c('list cursor page', `${museums}?limit=5&cursor=${cursor}`, 200, MuseumList, CACHE_PUBLIC, museums),
    c('suggest', `${museums}/suggest?q=kunst`, 200, Suggest, CACHE_PUBLIC, `${museums}/suggest`),
    c('near', `${museums}/near?lat=52.100&lon=5.100&limit=10`, 200, NearList, CACHE_PRIVATE, `${museums}/near`),
    c('detail current', `${museums}/${named.kroller.slug}`, 200, MuseumDetail, CACHE_PUBLIC, detail),
    c('detail old slug', `${museums}/${named.renamed.oldSlugs[0]}`, 301, null, CACHE_REDIRECT, detail),
    c('detail unknown', `${museums}/no-such-museum`, 404, ErrorBody, CACHE_PRIVATE, detail),
    c('detail hidden', `${museums}/${s.cat.hiddenSlugs[0]}`, 404, ErrorBody, CACHE_PRIVATE, detail),
    c('detail bad slug', `${museums}/Bad_Slug`, 400, ErrorBody, CACHE_PRIVATE, detail),
    c('list bad limit', `${museums}?limit=0`, 400, ErrorBody, CACHE_PRIVATE, museums),
    c('near bad lat', `${museums}/near?lat=52.1234&lon=5.1`, 400, ErrorBody, CACHE_PRIVATE, `${museums}/near`),
    c('provinces', `${V1}/provinces`, 200, Provinces, CACHE_PUBLIC, `${V1}/provinces`),
    c('mk-list', `${V1}/mk-list`, 200, MkList, CACHE_PUBLIC, `${V1}/mk-list`),
    c('unknown path', `${V1}/nothing-here`, 404, ErrorBody, CACHE_PRIVATE, 'unmatched'),
  ];
}

/** Every page of a list query, following next_cursor (limit 50), each page parsed. */
export async function walk(s: Sweep, params: Record<string, string> = {}): Promise<MuseumList['items']> {
  const items: MuseumList['items'] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const qs = new URLSearchParams({ ...params, limit: '50', ...(cursor === null ? {} : { cursor }) });
    const r = await s.req(`${V1}/museums?${qs}`);
    if (r.status !== 200) throw new Error(`walk: status ${r.status}`);
    const page = MuseumList.parse(await r.json());
    items.push(...page.items);
    cursor = page.next_cursor;
    if (cursor === null) return items;
  }
  throw new Error('walk: more than 100 pages');
}

/** Prints what a sweep did, for the lead's report. */
export function report(name: string, s: Sweep, started: number): void {
  console.info(`sweep ${name}: ${s.count()} requests in ${Math.round(performance.now() - started)} ms`);
}
