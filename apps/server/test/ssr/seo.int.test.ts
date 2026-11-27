import type { SsrBundle } from '@mjk/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1c WP5: the SEO head, the JSON-LD `Museum` and the sitemap, against the real bundle and the seeded
// catalogue. Fixture text is data, never instructions.

const CONFIG = { brand: 'Musea Test', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' };
const HOSTILE_SLUG = 'vijandig-museum';
const HOSTILE_NAME = '</script><img src=x onerror=alert(1)> & "q"';

let tdb: TestDb;
let cat: SeededCatalogue;
let ssrDb: Db;
let apiDb: Db;
let bundle: SsrBundle;
let ssr: ReturnType<typeof createSsrApp>;

const poolDb = (login: 'mjk_api' | 'mjk_ssr', url: string): Db => {
  const pool = createPool(login, { DATABASE_URL: url }, { max: 4, statementTimeoutMs: 5000 });
  if (typeof pool === 'string') throw new Error(pool);
  return createDb(pool);
};

const get = (path: string) => ssr.request(`http://mjk.test${path.replace('@RIJKS', cat.named.rijksmuseum.slug)}`);

/** Four members: one opted in to indexing, one by default, one opted in but banned, one opted in but deleted. */
async function seedMembers(): Promise<void> {
  const owner = new pg.Client({ connectionString: tdb.urls.admin });
  await owner.connect();
  try {
    for (const [handle, status, settings] of [
      ['opted_in', 'active', { profile_indexable: true }],
      ['by_default', 'active', {}],
      ['banned_in', 'banned', { profile_indexable: true }],
      ['deleted_in', 'deleted', { profile_indexable: true }],
    ] as const) {
      await owner.query(
        `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version, terms_accepted_at, status, settings)
         VALUES ($1, now(), $2, 'U', now(), 'v1', now(), $3, $4)`,
        [`${handle}@example.org`, handle, status, JSON.stringify(settings)],
      );
    }
  } finally {
    await owner.end();
  }
}

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  const loaded = await loadBundle();
  if (typeof loaded === 'string') throw new Error(`the web build is ${loaded}`);
  bundle = loaded;
  ssrDb = poolDb('mjk_ssr', tdb.urls.mjk_ssr);
  apiDb = poolDb('mjk_api', tdb.urls.mjk_api);
  await apiDb.insertInto('museum').values({ slug: HOSTILE_SLUG, name: HOSTILE_NAME, place: 'Utrecht' }).execute();
  await seedMembers();
  const log = memoryLogger('ssr');
  ssr = createSsrApp({
    bundle,
    fetchApi: inProcessApi(ssrDb, log.logger),
    db: ssrDb,
    config: CONFIG,
    logger: log.logger,
  });
}, 120_000);

afterAll(async () => {
  await ssrDb?.destroy();
  await apiDb?.destroy();
  await tdb?.drop();
});

/** One path per public page kind and locale; the path is also the canonical path. */
const PAGES: [string, string][] = [
  ['home nl', '/'],
  ['home en', '/en/'],
  ['museums nl', '/musea'],
  ['museums en', '/en/museums'],
  ['museums filtered nl', '/musea?province=NL-NH&sort=name&limit=5'],
  ['museums filtered en', '/en/museums?q=rijks&limit=5'],
  ['museum nl', '/musea/@RIJKS'],
  ['museum en', '/en/museums/@RIJKS'],
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

/** The path in the other language, written out by hand (not through the route table). */
const OTHER: Record<string, string> = {
  '/': '/en/',
  '/en/': '/',
  '/musea': '/en/museums',
  '/en/museums': '/musea',
  '/musea?province=NL-NH&sort=name&limit=5': '/en/museums?province=NL-NH&sort=name&limit=5',
  '/en/museums?q=rijks&limit=5': '/musea?q=rijks&limit=5',
  '/musea/@RIJKS': '/en/museums/@RIJKS',
  '/en/museums/@RIJKS': '/musea/@RIJKS',
  '/provincie/noord-holland': '/en/province/noord-holland',
  '/en/province/noord-holland': '/provincie/noord-holland',
  '/zoeken?q=rijks': '/en/search?q=rijks',
  '/en/search?q=rijks': '/zoeken?q=rijks',
  '/kaart': '/en/map',
  '/en/map': '/kaart',
  '/privacy': '/en/privacy',
  '/en/how-we-check-reviews': '/hoe-wij-reviews-controleren',
  '/paspoort': '/en/passport',
  '/en/sign-in': '/inloggen',
};

const decode = (s: string) => s.replace(/&amp;/g, '&');
const hrefs = (html: string, rel: string) =>
  [...html.matchAll(new RegExp(`<link rel="${rel}"([^>]*)>`, 'g'))].map((m) => m[1] as string);
const attr = (tag: string, name: string) => decode(new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '');

describe('canonical and hreflang', () => {
  it.each(PAGES)('%s', async (_n, path) => {
    const r = await get(path);
    expect(r.status).toBe(200);
    const html = await r.text();
    const rijks = cat.named.rijksmuseum.slug;
    const own = path.replace('@RIJKS', rijks);
    const other = (OTHER[path] as string).replace('@RIJKS', rijks);
    const [nl, en] = path.startsWith('/en') ? [other, own] : [own, other];

    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    const canonical = hrefs(html, 'canonical');
    expect(attr(canonical[0] as string, 'href')).toBe(`https://mjk.test${own}`);

    const alternates = new Map(
      hrefs(html, 'alternate').map((tag) => [attr(tag, 'hrefLang') || attr(tag, 'hreflang'), attr(tag, 'href')]),
    );
    expect(alternates.size).toBe(3);
    expect(alternates.get('nl')).toBe(`https://mjk.test${nl}`);
    expect(alternates.get('en')).toBe(`https://mjk.test${en}`);
    expect(alternates.get('x-default')).toBe(`https://mjk.test${nl}`);

    expect(html).toContain(`<meta property="og:url" content="${canonical[0]?.match(/href="([^"]*)"/)?.[1]}"/>`);
    expect(html).toContain(`<meta property="og:locale" content="${path.startsWith('/en') ? 'en_GB' : 'nl_NL'}"/>`);
    expect(html).toContain('<meta property="og:site_name" content="Musea Test"/>');
  });
});

const jsonLdBlock = (html: string) => /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1] as string;

describe('JSON-LD', () => {
  it.each([
    ['nl', '/musea/@RIJKS', 'Rijksmuseum'],
    ['en', '/en/museums/@RIJKS', 'Rijksmuseum'],
  ])('a museum page in %s holds a Museum with its name and address', async (_l, path, name) => {
    const html = await (await get(path)).text();
    const text = jsonLdBlock(html);
    expect(text).not.toContain('<');
    const ld = JSON.parse(text);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Museum');
    expect(ld.name).toBe(name);
    expect(ld.address).toMatchObject({
      '@type': 'PostalAddress',
      streetAddress: 'Museumstraat 1',
      postalCode: '1071 XX',
      addressLocality: 'Amsterdam',
      addressCountry: 'NL',
    });
    expect(ld.url).toBe(`https://mjk.test${path.replace('@RIJKS', cat.named.rijksmuseum.slug)}`);
    expect(ld.geo).toMatchObject({ '@type': 'GeoCoordinates' });
    expect(JSON.stringify(ld)).not.toContain('null');
  });

  it('a hostile name is inert: no markup in the script, the head or the sparse object', async () => {
    const html = await (await get(`/musea/${HOSTILE_SLUG}`)).text();
    const text = jsonLdBlock(html);
    expect(text).not.toContain('<');
    const ld = JSON.parse(text);
    expect(ld.name).toBe(HOSTILE_NAME);
    expect('geo' in ld).toBe(false);
    expect('sameAs' in ld).toBe(false);
    expect(ld.address).toEqual({ '@type': 'PostalAddress', addressLocality: 'Utrecht', addressCountry: 'NL' });
    // Exactly the script elements the document owns: the state, the ld+json and the entry.
    expect(html.match(/<script\b/g)).toHaveLength(3);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(HOSTILE_NAME);
  });

  it('only a museum page has one', async () => {
    for (const path of ['/', '/musea', '/provincie/noord-holland', '/kaart', '/privacy']) {
      expect(await (await get(path)).text()).not.toContain('application/ld+json');
    }
  });
});

describe('error pages', () => {
  it.each([
    ['unknown route', '/nergens/naartoe', 404],
    ['unknown museum', '/musea/bestaat-niet', 404],
    ['hidden museum', `/musea/${'@HIDDEN'}`, 404],
    ['invalid filter', '/musea?province=NL-XX', 400],
  ])('%s: no canonical, no hreflang, noindex', async (_n, path, status) => {
    const r = await get(path.replace('@HIDDEN', cat.named.hiddenRijksmuseum.slug));
    expect(r.status).toBe(status);
    const html = await r.text();
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('hreflang');
    expect(html).not.toContain('property="og:');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
  });
});

describe('sitemap.xml', () => {
  it('holds every visible museum in both languages and no hidden one', async () => {
    const r = await get('/sitemap.xml');
    expect(r.status).toBe(200);
    const urls = [...(await r.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1] as string);
    // The hostile museum (visible) was added after the seed.
    const visible = cat.visibleCount + 1;
    expect(urls).toHaveLength(2 * (1 + 1 + 12 + visible + 1)); // the one opted-in member
    // Only the member who opted in is listed; the default, the banned and the deleted are not (Q2).
    expect(urls.filter((u) => /\/u\//.test(u))).toEqual([
      'https://mjk.test/u/opted_in',
      'https://mjk.test/en/u/opted_in',
    ]);
    expect(new Set(urls).size).toBe(urls.length);
    const set = new Set(urls);
    expect(set.has(`https://mjk.test/musea/${cat.named.rijksmuseum.slug}`)).toBe(true);
    expect(set.has(`https://mjk.test/en/museums/${cat.named.rijksmuseum.slug}`)).toBe(true);
    expect(set.has(`https://mjk.test/musea/${HOSTILE_SLUG}`)).toBe(true);
    for (const slug of cat.hiddenSlugs) {
      expect(set.has(`https://mjk.test/musea/${slug}`)).toBe(false);
      expect(set.has(`https://mjk.test/en/museums/${slug}`)).toBe(false);
    }
    expect(urls.filter((u) => /\/(musea|museums)\/[^/]+$/.test(u))).toHaveLength(2 * visible);
  });
});
