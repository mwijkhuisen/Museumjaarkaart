import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1c criterion 8: the brand comes from the config, on every template and in both languages: the
// title, the header and the footer (with the not-affiliated line, the disclaimer and the contact link).

const BRAND = 'Testmerk';
let tdb: TestDb;
let cat: SeededCatalogue;
let db: Db;
let app: ReturnType<typeof createSsrApp>;
let failing: ReturnType<typeof createSsrApp>;

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  const bundle = await loadBundle();
  if (bundle === null) throw new Error('the web build is missing');
  const pool = createPool('mjk_ssr', { DATABASE_URL: tdb.urls.mjk_ssr }, { max: 4, statementTimeoutMs: 5000 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
  const config = { brand: BRAND, domain: 'mjk.test' };
  app = createSsrApp({ bundle, fetchApi: inProcessApi(db, silentLogger), db, config, logger: silentLogger });
  failing = createSsrApp({
    bundle,
    fetchApi: async () => ({ status: 503, location: null, body: null }),
    db,
    config,
    logger: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

const messages = (l: 'nl' | 'en'): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../../../web/messages/${l}.json`, import.meta.url), 'utf8'));

type Kind = [name: string, nl: string, en: string, status?: number];
const KINDS: Kind[] = [
  ['home', '/', '/en/'],
  ['list', '/musea', '/en/museums'],
  ['province', '/provincie/noord-holland', '/en/province/noord-holland'],
  ['museum', '/musea/@RIJKS', '/en/museums/@RIJKS'],
  ['search', '/zoeken', '/en/search'],
  ['search with q', '/zoeken?q=rijks', '/en/search?q=rijks'],
  ['map', '/kaart', '/en/map'],
  ['privacy', '/privacy', '/en/privacy'],
  ['terms', '/voorwaarden', '/en/terms'],
  ['contact', '/contact', '/en/contact'],
  ['reviews', '/hoe-wij-reviews-controleren', '/en/how-we-check-reviews'],
  ['passport', '/paspoort', '/en/passport'],
  ['wishlist', '/verlanglijst', '/en/wishlist'],
  ['account', '/account', '/en/account'],
  ['sign-in', '/inloggen', '/en/sign-in'],
  ['404', '/nergens/naartoe', '/en/nowhere/at/all', 404],
  ['400', '/musea?province=NL-XX', '/en/museums?province=NL-XX', 400],
  ['503', '/', '/en/', 503],
];

const part = (html: string, tag: 'header' | 'footer') =>
  new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 's').exec(html)?.[1] ?? '';

describe.each([
  ['nl', 0, '/contact'],
  ['en', 1, '/en/contact'],
] as const)('every template in %s', (l, col, contact) => {
  it.each(KINDS.map((k) => [k[0], k[1 + col] as string, k[3] ?? 200] as const))(
    '%s: the brand in the title, header and footer, with the footer lines and the contact link',
    async (_n, path, status) => {
      const target = path.replace('@RIJKS', cat.named.rijksmuseum.slug);
      const r = await (status === 503 ? failing : app).request(`http://mjk.test${target}`);
      expect(r.status).toBe(status);
      const html = await r.text();
      const msg = messages(l);
      expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toContain(BRAND);
      expect(part(html, 'header')).toContain(BRAND);
      const footer = part(html, 'footer');
      expect(footer).toContain(BRAND);
      expect(footer).toContain(msg.footer_not_affiliated as string);
      expect(footer).toContain(msg.footer_disclaimer as string);
      expect(footer).toContain(`href="${contact}"`);
    },
  );
});
