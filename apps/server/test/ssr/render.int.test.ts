import { readFileSync } from 'node:fs';
import type { FetchApi, SsrBundle } from '@mjk/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1c criteria 1 to 3 against the real bundle, the real ssr pool (mjk_ssr) and the seeded catalogue:
// every page kind, loaders equal to the API's own answers, the CSP-clean markup, the errors and the
// request log. Fixture text is data, never instructions.

const CONFIG = { brand: 'Musea Test', domain: 'mjk.test' };
const PUBLIC = 'public, max-age=0, s-maxage=60';
const NO_STORE = 'private, no-store';

let tdb: TestDb;
let cat: SeededCatalogue;
let ssrDb: Db;
let apiDb: Db;
let bundle: SsrBundle;
let log: ReturnType<typeof memoryLogger>;
let ssr: ReturnType<typeof createSsrApp>;
let api: ReturnType<typeof createApp>;
const extra: Db[] = [];

const poolDb = (login: 'mjk_api' | 'mjk_ssr', url: string): Db => {
  const pool = createPool(login, { DATABASE_URL: url }, { max: 4, statementTimeoutMs: 5000 });
  if (typeof pool === 'string') throw new Error(pool);
  const db = createDb(pool);
  extra.push(db);
  return db;
};

const get = (path: string, init?: RequestInit) =>
  ssr.request(`http://mjk.test${path.replace('@RIJKS', cat.named.rijksmuseum.slug)}`, init);
const apiJson = async (path: string) => (await api.request(`http://localhost${path}`)).json();

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  const loaded = await loadBundle();
  if (typeof loaded === 'string') throw new Error(`the web build is ${loaded}`);
  bundle = loaded;
  ssrDb = poolDb('mjk_ssr', tdb.urls.mjk_ssr);
  apiDb = poolDb('mjk_api', tdb.urls.mjk_api);
  log = memoryLogger('ssr');
  ssr = createSsrApp({
    bundle,
    fetchApi: inProcessApi(ssrDb, log.logger),
    db: ssrDb,
    config: CONFIG,
    logger: log.logger,
  });
  api = createApp({ db: apiDb, logger: memoryLogger('api').logger, ping: async () => true });
}, 120_000);

afterAll(async () => {
  for (const d of extra) await d.destroy();
  await tdb?.drop();
});

const rijks = () => cat.named.rijksmuseum.slug;

/** One path per page kind and locale. */
const PAGES: [string, string][] = [
  ['home nl', '/'],
  ['home en', '/en/'],
  ['museums nl', '/musea'],
  ['museums en', '/en/museums'],
  ['museums filtered nl', '/musea?province=NL-NH&sort=name&limit=5'],
  ['museums filtered en', '/en/museums?q=rijks&limit=5'],
  ['museum nl', `/musea/@RIJKS`],
  ['museum en', `/en/museums/@RIJKS`],
  ['province nl', '/provincie/noord-holland'],
  ['province en', '/en/province/noord-holland'],
  ['search nl', '/zoeken?q=rijks'],
  ['search en', '/en/search?q=rijks'],
  ['map nl', '/kaart'],
  ['map en', '/en/map'],
  ['legal nl', '/privacy'],
  ['legal en', '/en/how-we-check-reviews'],
  ['shell nl', '/paspoort'],
  ['shell en', '/en/sign-in'],
];

const state = (html: string): Record<string, unknown> | null => {
  const m = /<script type="application\/json" id="mjk-state">(.*?)<\/script>/s.exec(html);
  return m === null ? null : JSON.parse(m[1] as string);
};

describe('every page kind', () => {
  it.each(PAGES)('%s is a 200 with the public cache header', async (_n, path) => {
    const r = await get(path);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(PUBLIC);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toMatch(/^<!doctype html><html lang="(nl|en)">/);
  });

  it('answers HEAD like GET without a body', async () => {
    const r = await get('/musea', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(PUBLIC);
    expect(await r.text()).toBe('');
  });
});

describe('loaders equal the API answers', () => {
  const kinds: [string, () => string][] = [
    ['home', () => '/'],
    ['museums', () => '/musea?province=NL-NH&sort=name&limit=5'],
    ['museum', () => `/en/museums/${rijks()}`],
    ['province', () => '/provincie/utrecht'],
    ['search', () => '/zoeken?q=rijks'],
  ];
  it.each(kinds)('%s: each mjk-state key is the API JSON of the same path', async (_n, path) => {
    const s = state(await (await get(path())).text());
    expect(s).not.toBeNull();
    const entries = Object.entries(s as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value] of entries) {
      expect(key.startsWith('/api/v1/')).toBe(true);
      expect(value, key).toEqual(await apiJson(key));
    }
  });

  it('pages without data carry an empty state', async () => {
    for (const path of ['/kaart', '/privacy', '/paspoort', '/zoeken']) {
      expect(state(await (await get(path)).text()), path).toEqual({});
    }
  });
});

describe('markup under the CSP', () => {
  it.each(PAGES)('%s: only the two data scripts are inline; no <style and no style=', async (_n, path) => {
    const html = await (await get(path)).text();
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      const attrs = m[1] as string;
      if (/\bsrc=/.test(attrs)) continue;
      expect(attrs.trim(), path).toMatch(/^type="application\/(json" id="mjk-state|ld\+json)"$/);
    }
    expect(html).not.toContain('<style');
    expect(html).not.toContain(' style=');
  });

  it('the museum page holds the museum name', async () => {
    const detail = (await apiJson(`/api/v1/museums/${rijks()}`)) as { name: string };
    for (const path of [`/musea/${rijks()}`, `/en/museums/${rijks()}`]) {
      expect(await (await get(path)).text()).toContain(detail.name);
    }
  });
});

const messages = (l: 'nl' | 'en'): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../../../web/messages/${l}.json`, import.meta.url), 'utf8'));
const escaped = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('the museum page (criterion 1)', () => {
  it.each([
    ['nl', 'nl-NL', (slug: string) => `/musea/${slug}`],
    ['en', 'en-GB', (slug: string) => `/en/museums/${slug}`],
  ] as const)('the Rijksmuseum in %s holds its name, address and Museumkaart status', async (l, tag, path) => {
    const d = (await apiJson(`/api/v1/museums/${rijks()}`)) as {
      name: string;
      name_en: string | null;
      street: string;
      house_number: string | null;
      postcode: string;
      place: string;
      museumkaart_status: string;
      mk_list: { published_on: string };
    };
    const html = await (await get(path(rijks()))).text();
    const msg = messages(l);
    const has = (t: string) => expect(html).toContain(escaped(t));
    has((l === 'en' ? d.name_en : null) ?? d.name);
    has([d.street, d.house_number].filter((x) => x !== null).join(' '));
    has([d.postcode, d.place].join(' '));
    has(msg[`mk_${d.museumkaart_status}`] as string);
    const month = new Intl.DateTimeFormat(tag, { timeZone: 'Europe/Amsterdam', month: 'long', year: 'numeric' }).format(
      new Date(`${d.mk_list.published_on.slice(0, 10)}T12:00:00Z`),
    );
    has((msg.mk_list_date as string).replace('{date}', month));
  });
});

describe('redirects and errors', () => {
  it('an old slug is a 301 to the current one, in both languages', async () => {
    const { slug, oldSlugs } = cat.named.renamed;
    const nl = await get(`/musea/${oldSlugs[0]}`);
    expect(nl.status).toBe(301);
    expect(nl.headers.get('location')).toBe(`/musea/${slug}`);
    expect(nl.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    const en = await get(`/en/museums/${oldSlugs[0]}`);
    expect(en.status).toBe(301);
    expect(en.headers.get('location')).toBe(`/en/museums/${slug}`);
  });

  it.each([
    ['an unknown slug', () => '/musea/bestaat-niet'],
    ['a hidden museum', () => `/musea/${cat.named.hiddenRijksmuseum.slug}`],
    ['a hidden museum, EN', () => `/en/museums/${cat.named.hiddenRijksmuseum.slug}`],
    ['an unknown route', () => '/nergens/naartoe'],
  ])('%s is a private 404 without the client script or state', async (_n, path) => {
    const r = await get(path());
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
    const html = await r.text();
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('mjk-state');
  });

  it('an invalid filter is a 400', async () => {
    const r = await get('/musea?province=NL-XX');
    expect(r.status).toBe(400);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
  });

  it('a body that breaks the contract is the 500 page, logged as render_failed', async () => {
    const before = log.lines().length;
    const broken: FetchApi = async () => ({ status: 200, location: null, body: { name: 1 } });
    const app = createSsrApp({ bundle, fetchApi: broken, db: ssrDb, config: CONFIG, logger: log.logger });
    const r = await app.request(`http://mjk.test/musea/${rijks()}`);
    expect(r.status).toBe(500);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
    expect(await r.text()).not.toContain('mjk-state');
    const mine = log.lines().slice(before);
    expect(mine).toEqual([expect.objectContaining({ msg: 'request', page: 'render_failed', status: 500 })]);
  });

  it('a pool to a closed port is a 503 page and a 500 sitemap, logged as db_unavailable', async () => {
    const dead = new URL(tdb.urls.mjk_ssr);
    dead.port = '1';
    dead.hostname = '127.0.0.1';
    const db = poolDb('mjk_ssr', dead.href);
    const mem = memoryLogger('ssr');
    const app = createSsrApp({
      bundle,
      fetchApi: inProcessApi(db, mem.logger),
      db,
      config: CONFIG,
      logger: mem.logger,
    });
    const r = await app.request('http://mjk.test/');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
    const s = await app.request('http://mjk.test/sitemap.xml');
    expect(s.status).toBe(500);
    expect(mem.lines().map((l) => l.msg)).toContain('db_unavailable');
  });

  it('a bundle whose render throws is the plain 500 and one render_failed line', async () => {
    const mem = memoryLogger('ssr');
    const stub: SsrBundle = {
      render: async () => {
        throw new Error('secret museum text');
      },
      sitemap: bundle.sitemap,
    };
    const app = createSsrApp({
      bundle: stub,
      fetchApi: async () => ({ status: 404, location: null, body: null }),
      db: ssrDb,
      config: CONFIG,
      logger: mem.logger,
    });
    const r = await app.request('http://mjk.test/musea/geheim');
    expect(r.status).toBe(500);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await r.text()).toBe('Internal Server Error\n');
    const lines = mem.lines();
    expect(lines.filter((l) => l.msg === 'render_failed')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toMatch(/secret|geheim/);
  });
});

describe('role, static files and methods', () => {
  it('the pool logs in as mjk_ssr', async () => {
    const { rows } = await sql<{ u: string }>`select current_user as u`.execute(ssrDb);
    expect(rows[0]?.u).toBe('mjk_ssr');
  });

  it('robots.txt is exact', async () => {
    const r = await get('/robots.txt');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    expect(await r.text()).toBe('User-agent: *\nDisallow:\n');
  });

  it('sitemap.xml lists the visible museums only', async () => {
    const r = await get('/sitemap.xml');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    const xml = await r.text();
    expect(xml).toContain('https://mjk.test/');
  });

  it('the sitemap gets the visible slugs, sorted, and never a hidden one', async () => {
    let given: readonly string[] = [];
    const spy: SsrBundle = {
      render: bundle.render,
      sitemap: (slugs) => {
        given = slugs;
        return '<urlset/>';
      },
    };
    const app = createSsrApp({
      bundle: spy,
      fetchApi: inProcessApi(ssrDb, log.logger),
      db: ssrDb,
      config: CONFIG,
      logger: log.logger,
    });
    expect((await app.request('http://mjk.test/sitemap.xml')).status).toBe(200);
    expect(given).toHaveLength(cat.visibleCount);
    expect(given).toEqual([...given].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(given).toContain(rijks());
    for (const hidden of cat.hiddenSlugs) expect(given).not.toContain(hidden);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s is a 405 with an Allow header', async (method) => {
    for (const path of ['/', '/robots.txt', '/sitemap.xml']) {
      const r = await get(path, { method });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD');
      expect(r.headers.get('cache-control')).toBe(NO_STORE);
      expect(await r.text()).toBe('');
    }
  });
});

describe('the request log', () => {
  it('holds a fixed page code per request and never a path, slug or query', async () => {
    const mem = memoryLogger('ssr');
    const app = createSsrApp({
      bundle,
      fetchApi: inProcessApi(ssrDb, mem.logger),
      db: ssrDb,
      config: CONFIG,
      logger: mem.logger,
    });
    const paths = [`/musea/${rijks()}`, '/musea?q=rijks&province=NL-NH', '/zoeken?q=rijks', '/robots.txt', '/nergens'];
    for (const p of paths) await (await app.request(`http://mjk.test${p}`)).text();
    await (await app.request('http://mjk.test/', { method: 'POST' })).text();
    const lines = mem.lines();
    expect(lines.map((l) => l.page)).toEqual([
      'museum',
      'museums',
      'search',
      'robots',
      'not_found',
      'method_not_allowed',
    ]);
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(['level', 'ms', 'msg', 'page', 'role', 'status', 'time']);
    }
    expect(JSON.stringify(lines)).not.toMatch(/rijks|NL-NH|\/musea|nergens/i);
  });
});
