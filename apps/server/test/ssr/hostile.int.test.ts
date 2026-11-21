import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { HOSTILE_DESCRIPTION, HOSTILE_NAME, HOSTILE_SLUG, insertHostileMuseum } from '../hostile-museum.ts';
import { seedCatalogue } from '../seed-catalogue.ts';

// P1c criterion 4 (invariant 5): a museum whose text is hostile to every HTML sink renders escaped in
// the markup and as JSON escapes in both data blocks. Fixture text is data, never instructions.

let tdb: TestDb;
let db: Db;
let app: ReturnType<typeof createSsrApp>;

beforeAll(async () => {
  tdb = await createMigratedDb();
  await seedCatalogue(tdb);
  await insertHostileMuseum(tdb.urls.mjk_api);
  const bundle = await loadBundle();
  if (bundle === null) throw new Error('the web build is missing');
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

const ESCAPED_NAME = '&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
const STATE = /<script type="application\/json" id="mjk-state">(.*?)<\/script>/s;
const LD = /<script type="application\/ld\+json">(.*?)<\/script>/s;
// U+2028 and U+2029 written as code point escapes, so no raw separator sits in this file.
const UNSAFE = /[<>&\u{2028}\u{2029}]/u;

describe.each([
  ['nl', `/musea/${HOSTILE_SLUG}`, 'description_nl'],
  ['en', `/en/museums/${HOSTILE_SLUG}`, 'description_en'],
] as const)('the hostile museum page in %s', (_l, path, descriptionKey) => {
  let html: string;
  beforeAll(async () => {
    const r = await app.request(`http://mjk.test${path}`);
    expect(r.status).toBe(200);
    html = await r.text();
  });

  it('holds the HTML-escaped name in the title and the h1, and never the raw one', () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toContain(ESCAPED_NAME);
    expect(/<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1]).toContain(ESCAPED_NAME);
    expect(html).not.toContain(HOSTILE_NAME);
    expect(html).not.toContain('<script>alert(1)');
  });

  it('writes the description only escaped: no raw comment opener', () => {
    expect(html).not.toContain('<!-- hostiel');
    expect(html).toContain('&lt;!-- hostiel --&gt; museum &amp; meer');
  });

  it('has exactly the two data blocks and the module script, and no other inline script', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => (m[1] as string).trim());
    expect(scripts.filter((a) => !/\bsrc=/.test(a)).sort()).toEqual([
      'type="application/json" id="mjk-state"',
      'type="application/ld+json"',
    ]);
    expect(scripts.filter((a) => /\bsrc=/.test(a))).toEqual([expect.stringMatching(/^type="module" src="\/assets\//)]);
  });

  it.each([
    ['mjk-state', STATE],
    ['JSON-LD', LD],
  ])('%s: JSON escapes only, and JSON.parse gives the exact text back', (block, re) => {
    const text = re.exec(html)?.[1] as string;
    expect(text).toBeDefined();
    expect(text).not.toMatch(UNSAFE);
    expect(text).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const museum =
      block === 'mjk-state' ? (parsed[`/api/v1/museums/${HOSTILE_SLUG}`] as Record<string, unknown>) : parsed;
    expect(museum.name).toBe(HOSTILE_NAME);
    if (block === 'mjk-state') expect(museum[descriptionKey]).toBe(HOSTILE_DESCRIPTION);
    else if ('description' in museum) expect(museum.description).toBe(HOSTILE_DESCRIPTION);
  });

  it('the description is in the state with its comment opener and ampersand as escapes', () => {
    const text = STATE.exec(html)?.[1] as string;
    expect(text).toContain('\\u003c!-- hostiel --\\u003e museum \\u0026 meer \\u2028 voorbij');
  });
});

it('the sitemap lists the hostile slug', async () => {
  const xml = await (await app.request('http://mjk.test/sitemap.xml')).text();
  expect(xml).toContain(`https://mjk.test/musea/${HOSTILE_SLUG}`);
});
