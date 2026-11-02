import { ErrorBody, MuseumList, Suggest } from '@mjk/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, buildApp } from '../../src/api/app.ts';
import { mountMuseumsList } from '../../src/api/routes/museums-list.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { listMuseums } from '../../src/museums/query.ts';
import { matches, setThreshold, suggestMuseums, WORD_SIMILARITY_THRESHOLD } from '../../src/museums/search.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1b criterion 1: search on the seeded 1,400-museum catalogue (30 of them hidden), through the real
// route and through the functions as mjk_ssr. Fixture text is data, never instructions.

let tdb: TestDb;
let cat: SeededCatalogue;
let api: Db;
let ssr: Db;
let app: ApiApp;

const pool = (login: 'mjk_api' | 'mjk_ssr') => {
  const p = createPool(login, { DATABASE_URL: tdb.urls[login] }, { max: 3 });
  if (typeof p === 'string') throw new Error(p);
  return createDb(p);
};

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  api = pool('mjk_api');
  ssr = pool('mjk_ssr');
  app = buildApp({ db: api, logger: silentLogger, ping: async () => true }, (v1, deps) => mountMuseumsList(v1, deps));
}, 120_000);

afterAll(async () => {
  await api?.destroy();
  await ssr?.destroy();
  await tdb?.drop();
});

const url = (path: string, params: Record<string, string>) =>
  `http://localhost/api/v1${path}?${new URLSearchParams(params)}`;
const list = (params: Record<string, string>) => app.request(url('/museums', params));
const suggest = (params: Record<string, string>) => app.request(url('/museums/suggest', params));
const listOk = async (params: Record<string, string>) => {
  const r = await list(params);
  expect(r.status).toBe(200);
  return MuseumList.parse(await r.json());
};

/** Every page of a search, following next_cursor. */
async function all(params: Record<string, string>): Promise<MuseumList['items']> {
  const items: MuseumList['items'] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const page = await listOk({ ...params, limit: '50', ...(cursor === null ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.next_cursor;
    if (cursor === null) return items;
  }
  throw new Error('too many pages');
}

describe('search', () => {
  it('finds the Kroller-Muller Museum first by "kroller muller", though no name of it is unaccented', async () => {
    const page = await listOk({ q: 'kroller muller' });
    expect(page.items[0]?.id).toBe(cat.named.kroller.id);
    expect(page.items[0]?.name).toMatch(/Kröller/);
    expect(page.total).toBeLessThan(20);
  });

  it('finds the Rijksmuseum first by the typo "rijksmusem", and the threshold is not too broad', async () => {
    const page = await listOk({ q: 'rijksmusem' });
    expect(page.items[0]?.id).toBe(cat.named.rijksmuseum.id);
    console.info(`threshold ${WORD_SIMILARITY_THRESHOLD}: q=rijksmusem finds ${page.total} museums`);
    expect(page.total).toBeLessThan(20);
    expect(page.items.length).toBe(page.total);
    // The exact word finds the Rijksmuseum first, too, and not a hundred unrelated names.
    const exact = await listOk({ q: 'rijksmuseum' });
    expect(exact.items[0]?.id).toBe(cat.named.rijksmuseum.id);
    console.info(`threshold ${WORD_SIMILARITY_THRESHOLD}: q=rijksmuseum finds ${exact.total} museums`);
    expect(exact.total).toBeLessThan(30);
  });

  it('tolerates a typo in a short name and in a two-word name', async () => {
    expect((await listOk({ q: 'tylers' })).items.map((i) => i.name)).toContain('Teylers Museum');
    const k = await listOk({ q: 'kroler muler' });
    expect(k.items[0]?.id).toBe(cat.named.kroller.id);
  });

  it('never returns a hidden museum, not even for its own name', async () => {
    const hidden = new Set(cat.hiddenIds);
    const some = async (q: string) => {
      for (const i of await all({ q })) expect(hidden.has(i.id), `${q}: ${i.name}`).toBe(false);
    };
    for (const q of ['Rijksmuseum Amsterdam', 'kroller muller', 'beeldentuin', 'depot', 'rijksmuseum']) await some(q);
    const names = await sql<{ name: string }>`SELECT name FROM museum WHERE hidden`.execute(api);
    expect(names.rows.length).toBe(cat.hiddenIds.length);
    for (const { name } of names.rows) await some([...name].slice(0, 100).join(''));
    expect(await all({ q: 'Rijksmuseum Amsterdam' })).not.toEqual([]);
  });

  it('keeps hidden museums out of the suggestions', async () => {
    const hidden = new Set(cat.hiddenSlugs);
    const names = await sql<{ name: string }>`SELECT name FROM museum WHERE hidden`.execute(api);
    for (const { name } of names.rows) {
      const r = await suggest({ q: [...name].slice(0, 100).join('') });
      expect(r.status).toBe(200);
      for (const i of Suggest.parse(await r.json()).items) expect(hidden.has(i.slug)).toBe(false);
    }
  });

  it.each([
    "'",
    "''",
    '&',
    '|',
    '!',
    ':*',
    '<->',
    '(',
    ')',
    '\\',
    "kroller:* & !(muller | 'x') <-> \\",
    "'kroller' & 'muller':*",
    '"kroller muller" -museum OR rijks',
    '!!!',
    '%_',
    'a'.repeat(100),
  ])('answers 200 for the tsquery syntax %j', async (q) => {
    const r = await list({ q });
    expect(r.status).toBe(200);
    MuseumList.parse(await r.json());
    expect((await suggest({ q })).status).toBe(200);
  });

  it('answers 200 for 100 code points (astral characters) and 400 for 101', async () => {
    const ok = await list({ q: '𝔸'.repeat(100) });
    expect(ok.status).toBe(200);
    expect((await listOk({ q: '𝔸'.repeat(100) })).items).toEqual([]);
    for (const path of ['/museums', '/museums/suggest']) {
      const r = await app.request(url(path, { q: '𝔸'.repeat(101) }));
      expect(r.status).toBe(400);
      expect(ErrorBody.parse(await r.json())).toEqual({ error: 'bad_request', fields: ['q'] });
    }
    expect((await list({ q: 'a'.repeat(101) })).status).toBe(400);
    expect((await list({ q: '' })).status).toBe(400);
  });

  it.each([
    ['<script>alert(1)</script> Museum', 'alert'],
    ['Museum ‮evil‬', 'evil'],
    ["Robert'); DROP TABLE museum;--", "Robert'); DROP TABLE museum;--"],
    ['"Quotes" & <Ampersands>', 'Ampersands'],
  ])('finds the hostile name %j and returns it as plain JSON', async (name, q) => {
    const found = await sql<{ id: string }>`SELECT id FROM pub_museum WHERE name = ${name}`.execute(ssr);
    expect(found.rows.length).toBe(1);
    const r = await list({ q });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await r.text();
    expect(text).toContain(JSON.stringify(name));
    const page = MuseumList.parse(JSON.parse(text));
    expect(page.items.map((i) => i.id)).toContain(found.rows[0]?.id);
    const s = await suggest({ q });
    expect((await s.text()).includes(JSON.stringify(name))).toBe(true);
    // The statement was text, not SQL: the table is still there.
    expect(Number((await sql<{ n: string }>`SELECT count(*) AS n FROM pub_museum`.execute(ssr)).rows[0]?.n)).toBe(
      cat.visibleCount,
    );
  });
});

describe('the three tiers', () => {
  const tiersOf = async (q: string) =>
    api
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        await setThreshold(trx);
        return (await sql<{ id: string; tier: number; score: number }>`${matches(q)}`.execute(trx)).rows;
      });

  it('gives one row per museum, with the lowest tier', async () => {
    for (const q of ['kroller muller', 'rijks', 'museum', 'amsterdam museum', 'kroler muler']) {
      const rows = await tiersOf(q);
      expect(new Set(rows.map((r) => r.id)).size, q).toBe(rows.length);
      for (const r of rows) {
        expect([1, 2, 3]).toContain(r.tier);
        expect(r.score).toBeGreaterThanOrEqual(0);
      }
    }
    const k = (await tiersOf('kroller muller')).find((r) => r.id === cat.named.kroller.id);
    expect(k?.tier).toBe(1);
  });

  it('finds a museum through a typo in an alias only, after the name matches', async () => {
    // "Beeld en Geluid Den Haag" has the alias "Communicatiemuseum"; no word of its name resembles it.
    const rows = await tiersOf('communicatimuseum');
    const named = await sql<{ id: string }>`SELECT id FROM pub_museum WHERE name = 'Beeld en Geluid Den Haag'`.execute(
      ssr,
    );
    const hit = rows.find((r) => r.id === named.rows[0]?.id);
    expect(hit?.tier).toBe(3);
    const page = await listOk({ q: 'communicatimuseum' });
    expect(page.items.map((i) => i.id)).toContain(named.rows[0]?.id);
    // Order: by tier, then score descending, in the answer too.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const keys = page.items.map((i) => byId.get(i.id));
    for (let n = 1; n < keys.length; n++) {
      const a = keys[n - 1];
      const b = keys[n];
      if (a === undefined || b === undefined) throw new Error('missing tier row');
      expect(a.tier < b.tier || (a.tier === b.tier && a.score >= b.score)).toBe(true);
    }
  });
});

describe('suggest', () => {
  it('answers up to 10 names, best first, with the Suggest contract', async () => {
    const r = await suggest({ q: 'kroller muller' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    const body = Suggest.parse(await r.json());
    expect(body.items[0]?.name).toMatch(/Kröller/);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(['municipality_name', 'name', 'place', 'slug']);
    const many = Suggest.parse(await (await suggest({ q: 'museum' })).json());
    expect(many.items.length).toBe(10);
    expect(Suggest.parse(await (await suggest({ q: 'rijksmusem' })).json()).items[0]?.slug).toBe(
      cat.named.rijksmuseum.slug,
    );
  });

  it('requires q and refuses any other parameter', async () => {
    for (const [params, fields] of [
      [{}, ['q']],
      [{ q: '' }, ['q']],
      [{ q: 'a', limit: '5' }, []],
    ] as const) {
      const r = await suggest({ ...params });
      expect(r.status).toBe(400);
      expect(ErrorBody.parse(await r.json())).toEqual({ error: 'bad_request', fields });
    }
  });
});

describe('as mjk_ssr', () => {
  it('runs the search and the suggestions on the views alone', async () => {
    const page = await listMuseums(ssr, { q: 'kroller muller', limit: 20 });
    expect(page.items[0]?.id).toBe(cat.named.kroller.id);
    expect(MuseumList.parse(page).total).toBe(page.items.length);
    const s = await suggestMuseums(ssr, 'rijksmusem');
    expect(s[0]?.slug).toBe(cat.named.rijksmuseum.slug);
    const plain = await listMuseums(ssr, { limit: 5 });
    expect(plain.items.length).toBe(5);
    expect(plain.total).toBe(cat.visibleCount);
  });
});
