import { ErrorBody, MuseumDetail } from '@mjk/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.ts';
import { CACHE_PUBLIC, CACHE_REDIRECT } from '../../src/api/cache.ts';
import { mountMuseumDetail } from '../../src/api/routes/museum-detail.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { lookupMuseum } from '../../src/museums/detail.ts';
import { type Harness, openHarness } from '../admin/harness.ts';

// GET /api/v1/museums/:slug (A§14): 200, a 301 from an old slug straight to the current one, 404.
// The detail lookup reads only the pub_* views, so it also runs as mjk_ssr.

let h: Harness;
let owner: pg.Client;
let db: Db;
let ssr: Db;
let app: ReturnType<typeof buildApp>;
let ids: string[];

const get = (path: string) => app.request(`http://localhost${path}`);
const detail = (slug: string) => get(`/api/v1/museums/${slug}`);
const rename = async (ref: string, slug: string) => {
  const r = await h.admin('museum', 'slug', ref, slug);
  expect(r.code).toBe(0);
};
const expectError = async (r: Response, status: number, body: unknown) => {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(ErrorBody.parse(await r.json())).toEqual(body);
};

const FORBIDDEN = [
  'hidden',
  'pinned_fields',
  'rce_id',
  'wikidata_qid',
  'commons_file',
  'search',
  'name_folded',
  'sort_name',
  'mk_list_member',
  'created_at',
  'updated_at',
];

beforeAll(async () => {
  h = await openHarness();
  owner = new pg.Client({ connectionString: h.db.urls.admin });
  await owner.connect();
  await owner.query("INSERT INTO municipality (cbs_code, name, province_code) VALUES ('GM0363', 'Amsterdam', 'NL-NH')");
  const pool = createPool('mjk_api', { DATABASE_URL: h.db.urls.mjk_api }, { max: 2 });
  const ssrPool = createPool('mjk_ssr', { DATABASE_URL: h.db.urls.mjk_ssr }, { max: 2 });
  if (typeof pool === 'string' || typeof ssrPool === 'string') throw new Error('pool');
  db = createDb(pool);
  ssr = createDb(ssrPool);
  app = buildApp({ db, logger: silentLogger, ping: async () => true }, (v1, deps) => mountMuseumDetail(v1, deps));
  ids = await h.seed([
    { slug: 'a', name: 'Alpha', status: 'participating', qid: 'Q1' },
    { slug: 'other', name: 'Other' },
    { slug: 'secret', name: 'Secret', hidden: true },
  ]);
  await h.api.query(
    `UPDATE museum SET municipality_code = 'GM0363', place = 'Amsterdam', lat = 52.37, lon = 4.9,
       categories = ARRAY['art'], website = 'https://example.org/', postcode = '1011 AB',
       mk_last_verified_at = '2026-10-01T12:00:00Z', price_verified_at = '2026-10-02T08:30:00Z',
       admission_adult_cents = 1500, mk_since = '2020-01-01', description_nl = 'Een museum.'
     WHERE id = $1`,
    [ids[0]],
  );
});
afterAll(async () => {
  await db?.destroy();
  await ssr?.destroy();
  await owner?.end();
  await h?.close();
});

describe('detail', () => {
  it('answers 200 with the MuseumDetail contract and no internal key', async () => {
    const r = await detail('a');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(CACHE_PUBLIC);
    const body = (await r.json()) as Record<string, unknown>;
    const parsed = MuseumDetail.parse(body);
    expect(parsed).toMatchObject({
      id: ids[0],
      slug: 'a',
      name: 'Alpha',
      municipality_name: 'Amsterdam',
      province_code: 'NL-NH',
      categories: ['art'],
      museumkaart_status: 'participating',
      mk_last_verified_at: '2026-10-01T12:00:00.000Z',
      price_verified_at: '2026-10-02T08:30:00.000Z',
      admission_adult_cents: 1500,
      mk_since: '2020-01-01',
      mk_list: null,
    });
    for (const k of FORBIDDEN) expect(body).not.toHaveProperty(k);
  });

  it('carries mk_list null before a published list, then member true or false', async () => {
    const before = MuseumDetail.parse(await (await detail('a')).json());
    expect(before.mk_list).toBeNull();
    expect((await h.admin('list', 'publish', '--date', '2026-11-01')).code).toBe(0);
    const member = MuseumDetail.parse(await (await detail('a')).json());
    expect(member.mk_list).toEqual({ published_on: '2026-11-01', n: 1, member: true });
    const other = MuseumDetail.parse(await (await detail('other')).json());
    expect(other.mk_list).toEqual({ published_on: '2026-11-01', n: 1, member: false });
  });

  it('answers 404 for an unknown slug and for a hidden museum', async () => {
    await expectError(await detail('nope'), 404, { error: 'not_found' });
    await expectError(await detail('secret'), 404, { error: 'not_found' });
  });

  it.each(['Bad_Slug', '-x', 'x-', 'a--b', 'a'.repeat(121)])('answers 400 for the slug %s', async (slug) => {
    await expectError(await detail(slug), 400, { error: 'bad_request', fields: ['slug'] });
  });

  it('answers 400 for any query parameter', async () => {
    await expectError(await get('/api/v1/museums/a?x=1'), 400, { error: 'bad_request', fields: [] });
  });

  it('works as mjk_ssr: views only', async () => {
    const found = await lookupMuseum(ssr, 'a');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(MuseumDetail.parse(found.detail).slug).toBe('a');
    expect(await lookupMuseum(ssr, 'secret')).toEqual({ kind: 'missing' });
  });
});

describe('old slugs', () => {
  it('redirects a and b straight to c after a -> b -> c, and c answers 200', async () => {
    await rename('a', 'b');
    await rename('b', 'c');
    for (const old of ['a', 'b']) {
      const r = await detail(old);
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe('/api/v1/museums/c');
      expect(r.headers.get('cache-control')).toBe(CACHE_REDIRECT);
      expect(await r.text()).toBe('');
    }
    const c = await detail('c');
    expect(c.status).toBe(200);
    expect(MuseumDetail.parse(await c.json()).id).toBe(ids[0]);
    expect(await lookupMuseum(ssr, 'a')).toEqual({ kind: 'moved', slug: 'c' });
  });

  it('answers 200 for a slug taken back, and b and c redirect to it', async () => {
    await rename('c', 'a');
    expect((await detail('a')).status).toBe(200);
    for (const old of ['b', 'c']) {
      const r = await detail(old);
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe('/api/v1/museums/a');
    }
  });

  it('answers 404 for the current and the old slugs of a hidden museum', async () => {
    await h.api.query('UPDATE museum SET hidden = true WHERE id = $1', [ids[0]]);
    for (const slug of ['a', 'b', 'c']) await expectError(await detail(slug), 404, { error: 'not_found' });
    expect(await lookupMuseum(ssr, 'b')).toEqual({ kind: 'missing' });
    await h.api.query('UPDATE museum SET hidden = false WHERE id = $1', [ids[0]]);
    expect((await detail('b')).status).toBe(301);
  });
});
