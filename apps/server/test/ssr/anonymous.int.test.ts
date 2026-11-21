import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1c criterion 5 straight against ssr: a response never depends on the cookie, the session, the
// Host, the language or the client address, and ssr never sets a cookie.

let tdb: TestDb;
let cat: SeededCatalogue;
let db: Db;
let app: ReturnType<typeof createSsrApp>;

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  const bundle = await loadBundle();
  if (typeof bundle === 'string') throw new Error(`the web build is ${bundle}`);
  const pool = createPool('mjk_ssr', { DATABASE_URL: tdb.urls.mjk_ssr }, { max: 4, statementTimeoutMs: 5000 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
  app = createSsrApp({
    bundle,
    fetchApi: inProcessApi(db, silentLogger),
    db,
    config: { brand: 'Musea Test', domain: 'mjk.test' },
    logger: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

const SESSION = `__Host-mjk_sid=${'A'.repeat(43)}; theme=dark`;
const LOADED = {
  Cookie: SESSION,
  Authorization: 'Bearer x',
  Host: 'evil.example',
  'Accept-Language': 'en',
  'X-Forwarded-For': '203.0.113.9',
};

const headersOf = (r: Response) => [...r.headers].sort(([a], [b]) => a.localeCompare(b));

it('answers every page kind, error, redirect and static file the same with and without identity headers', async () => {
  const paths = [
    '/',
    '/en/',
    '/musea',
    '/en/museums?q=rijks&limit=5',
    `/musea/${cat.named.rijksmuseum.slug}`,
    `/en/museums/${cat.named.rijksmuseum.slug}`,
    '/provincie/noord-holland',
    '/zoeken?q=rijks',
    '/kaart',
    '/privacy',
    '/en/how-we-check-reviews',
    '/paspoort',
    '/en/sign-in',
    `/musea/${cat.named.renamed.oldSlugs[0]}`,
    '/musea/bestaat-niet',
    '/nergens',
    '/musea?province=NL-XX',
    '/sitemap.xml',
    '/robots.txt',
  ];
  for (const path of paths) {
    const plain = await app.request(`http://mjk.test${path}`);
    const loaded = await app.request(`http://mjk.test${path}`, { headers: LOADED });
    expect(loaded.status, path).toBe(plain.status);
    expect(headersOf(loaded), path).toEqual(headersOf(plain));
    expect(plain.headers.get('set-cookie'), path).toBeNull();
    expect(loaded.headers.get('set-cookie'), path).toBeNull();
    expect(plain.headers.get('x-request-id'), path).toBeNull();
    const a = Buffer.from(await plain.arrayBuffer());
    const b = Buffer.from(await loaded.arrayBuffer());
    expect(b.equals(a), path).toBe(true);
  }
});
