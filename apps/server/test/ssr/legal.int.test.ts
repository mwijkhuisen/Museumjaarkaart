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

// P1e criterion 5: the interim /privacy and /contact exist in NL and EN, carry the config's controller
// and email escaped, and every page's footer links to both. No `style=` anywhere (ADR-0009).

const CONTROLLER = `A&B <script>alert("x")</script> 'Beheer'`;
const EMAIL = 'info+x&y@mjk.test';
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
  const config = { brand: 'Testmerk', domain: 'mjk.test', controller: CONTROLLER, contactEmail: EMAIL };
  app = createSsrApp({ bundle, fetchApi: inProcessApi(db, silentLogger), db, config, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

const messages = (l: 'nl' | 'en'): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../../../web/messages/${l}.json`, import.meta.url), 'utf8'));

const get = async (path: string) => {
  const r = await app.request(`http://mjk.test${path}`);
  return { status: r.status, html: await r.text() };
};
const footer = (html: string) => /<footer\b[^>]*>(.*?)<\/footer>/s.exec(html)?.[1] ?? '';
const main = (html: string) => /<main\b[^>]*>(.*?)<\/main>/s.exec(html)?.[1] ?? '';
const escaped = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe.each([
  ['nl', '/privacy', '/contact'],
  ['en', '/en/privacy', '/en/contact'],
] as const)('the interim legal pages in %s', (l, privacy, contact) => {
  const msg = messages(l);
  // Paraglide message with a {controller} parameter, as the page renders it (text, escaped by React).
  const withController = (key: string) => escaped(msg[key]?.replace('{controller}', CONTROLLER) ?? '');

  it('privacy renders every section, the escaped controller and the email', async () => {
    const { status, html } = await get(privacy);
    expect(status).toBe(200);
    const body = main(html);
    for (const key of [
      'privacy_intro',
      'privacy_collect',
      'privacy_logs',
      'privacy_cloudflare',
      'privacy_backups',
      'privacy_rights',
      'privacy_h_collect',
      'privacy_h_logs',
      'privacy_h_cloudflare',
      'privacy_h_backups',
      'privacy_h_rights',
      'privacy_h_controller',
    ]) {
      expect(body).toContain(escaped(msg[key] as string));
    }
    expect(body).toContain('Cloudflare');
    expect(body).toContain(withController('privacy_controller'));
    expect(body).toContain(`href="mailto:${escaped(EMAIL)}"`);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain(msg.legal_soon as string);
  });

  it('contact renders the email, the operator and the not-affiliated line', async () => {
    const { status, html } = await get(contact);
    expect(status).toBe(200);
    const body = main(html);
    expect(body).toContain(escaped(msg.contact_lead as string));
    expect(body).toContain(`href="mailto:${escaped(EMAIL)}"`);
    expect(body).toContain(`>${escaped(EMAIL)}</a>`);
    expect(body).toContain(withController('contact_operator'));
    expect(body).toContain(escaped(msg.footer_not_affiliated as string));
    expect(html).not.toContain('<script>alert');
  });

  it('the controller and email reach the client through the head, escaped', async () => {
    const { html } = await get(privacy);
    expect(html).toContain(`<meta name="mjk-controller" content="${escaped(CONTROLLER)}"`);
    expect(html).toContain(`<meta name="mjk-contact" content="${escaped(EMAIL)}"`);
  });

  it('has no style attribute or style element', async () => {
    for (const path of [privacy, contact]) {
      const { html } = await get(path);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toContain('<style');
    }
  });
});

describe('every page footer links to /privacy and /contact', () => {
  const kinds: [string, string, string][] = [
    ['home', '/', '/en/'],
    ['list', '/musea', '/en/museums'],
    ['province', '/provincie/noord-holland', '/en/province/noord-holland'],
    ['museum', '/musea/@RIJKS', '/en/museums/@RIJKS'],
    ['search', '/zoeken', '/en/search'],
    ['map', '/kaart', '/en/map'],
    ['privacy', '/privacy', '/en/privacy'],
    ['contact', '/contact', '/en/contact'],
    ['terms', '/voorwaarden', '/en/terms'],
  ];
  it.each(
    kinds.flatMap(([n, nl, en]) => [
      [n, 'nl', nl, '/privacy', '/contact'] as const,
      [n, 'en', en, '/en/privacy', '/en/contact'] as const,
    ]),
  )('%s (%s)', async (_n, _l, path, privacy, contact) => {
    const { status, html } = await get(path.replace('@RIJKS', cat.named.rijksmuseum.slug));
    expect(status).toBe(200);
    expect(footer(html)).toContain(`href="${privacy}"`);
    expect(footer(html)).toContain(`href="${contact}"`);
  });
});
