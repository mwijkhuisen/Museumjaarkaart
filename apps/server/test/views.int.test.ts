import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// P1b (db/migrations/20261103000002_public_views.sql): every public query reads only the
// pub_* views, `hidden` is filtered in exactly one place, and mjk_ssr reads nothing else.

let db: TestDb;
const clients: pg.Client[] = [];
let owner: pg.Client;
let api: pg.Client;
let worker: pg.Client;
let ssr: pg.Client;
let n = 0;

const DENIED = '42501';
const VIEWS = ['pub_museum', 'pub_museum_alias', 'pub_slug_redirect', 'pub_province', 'pub_mk_list'] as const;

const PUB_MUSEUM_COLUMNS = [
  'id',
  'slug',
  'name',
  'name_en',
  'description_nl',
  'description_en',
  'street',
  'house_number',
  'postcode',
  'place',
  'municipality_code',
  'municipality_name',
  'province_code',
  'lat',
  'lon',
  'website',
  'museumnl_url',
  'registered',
  'categories',
  'museumkaart_status',
  'mk_since',
  'mk_until',
  'mk_last_verified_at',
  'admission_adult_cents',
  'price_verified_at',
  'photo_policy',
  'closed_on',
  'temp_closed',
  'temp_closed_until',
  'search',
  'name_folded',
  'sort_name',
  'mk_list_member',
];
const FORBIDDEN = ['hidden', 'pinned_fields', 'rce_id', 'wikidata_qid', 'commons_file', 'created_at', 'updated_at'];

const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? 'error',
  );
const newMuseum = async (c: pg.Client, row: Record<string, unknown> = {}) => {
  const full = { slug: `v-${n++}`, name: 'Museum', ...row };
  const cols = Object.keys(full);
  const res = await c.query<{ id: string }>(
    `INSERT INTO museum (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(full),
  );
  return (res.rows[0] as { id: string }).id;
};
const ids = async (view: string, col = 'id') =>
  (await api.query<Record<string, string>>(`SELECT ${col} FROM ${view} ORDER BY ${col}`)).rows.map(
    (r) => r[col] as string,
  );
const provinceCounts = async () =>
  Object.fromEntries(
    (await api.query<{ code: string; museum_count: number }>('SELECT code, museum_count FROM pub_province')).rows.map(
      (r) => [r.code, r.museum_count],
    ),
  );

beforeAll(async () => {
  db = await createMigratedDb();
  owner = await connect(db.urls.mjk_migrator);
  api = await connect(db.urls.mjk_api);
  worker = await connect(db.urls.mjk_worker);
  ssr = await connect(db.urls.mjk_ssr);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('access', () => {
  it('mjk_api and mjk_ssr can SELECT every pub_ view', async () => {
    for (const c of [api, ssr]) for (const v of VIEWS) expect(await code(c.query(`SELECT * FROM ${v}`)), v).toBe('ok');
  });

  it('mjk_ssr gets 42501 on every table of the public schema and on mk_list', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tables = rows.map((r) => r.tablename);
    expect(tables).toContain('museum_slug_redirect');
    expect(tables).toContain('museum');
    for (const t of tables) expect(await code(ssr.query(`SELECT 1 FROM "${t}" LIMIT 1`)), t).toBe(DENIED);
    expect(await code(ssr.query('SELECT 1 FROM mk_list LIMIT 1'))).toBe(DENIED);
  });

  it('no non-pub view in the public schema is readable by mjk_ssr', async () => {
    const { rows } = await owner.query<{ viewname: string }>(
      "SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname NOT LIKE 'pub\\_%'",
    );
    for (const r of rows)
      expect(await code(ssr.query(`SELECT 1 FROM "${r.viewname}" LIMIT 1`)), r.viewname).toBe(DENIED);
  });
});

describe('definitions', () => {
  it('each view is owned by mjk_migrator and has neither security_invoker nor security_barrier', async () => {
    const { rows } = await owner.query<{ relname: string; owner: string; opts: string[] | null }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.reloptions AS opts
         FROM pg_class c WHERE c.relkind = 'v' AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'pub\\_%'
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...VIEWS].sort());
    for (const r of rows) {
      expect(r.owner, r.relname).toBe('mjk_migrator');
      expect(
        (r.opts ?? []).filter((o) => /^security_(invoker|barrier)/.test(o)),
        r.relname,
      ).toEqual([]);
    }
  });

  it('pub_museum has exactly the public columns, and none of the internal ones', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pub_museum' ORDER BY ordinal_position`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(PUB_MUSEUM_COLUMNS);
    for (const f of FORBIDDEN) expect(cols, f).not.toContain(f);
    for (const v of VIEWS.filter((x) => x !== 'pub_museum')) {
      const r = await owner.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [v],
      );
      for (const f of FORBIDDEN)
        expect(
          r.rows.map((c) => c.column_name),
          `${v}.${f}`,
        ).not.toContain(f);
    }
  });

  it('the other views have the documented columns', async () => {
    const colsOf = async (v: string) =>
      (
        await owner.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [v],
        )
      ).rows.map((r) => r.column_name);
    expect(await colsOf('pub_museum_alias')).toEqual(['museum_id', 'alias', 'alias_folded']);
    expect(await colsOf('pub_slug_redirect')).toEqual(['old_slug', 'slug']);
    expect(await colsOf('pub_province')).toEqual(['code', 'name_nl', 'name_en', 'museum_count']);
    expect(await colsOf('pub_mk_list')).toEqual(['published_on', 'n']);
  });
});

describe('hidden museums', () => {
  let visible: string;
  let visible2: string;
  let noMunicipality: string;
  let hidden: string;

  beforeAll(async () => {
    await worker.query(`INSERT INTO municipality (cbs_code, name, province_code) VALUES
      ('GM0363', 'Amsterdam', 'NL-NH'), ('GM0599', 'Rotterdam', 'NL-ZH')`);
    visible = await newMuseum(api, {
      name: 'Kröller Zichtbaar',
      slug: 'zichtbaar',
      municipality_code: 'GM0363',
      place: 'Amsterdam',
    });
    visible2 = await newMuseum(api, { name: 'Tweede', slug: 'tweede', municipality_code: 'GM0363' });
    noMunicipality = await newMuseum(api, { name: 'Zonder gemeente', slug: 'zonder' });
    hidden = await newMuseum(api, { name: 'Verborgen', slug: 'verborgen-oud', municipality_code: 'GM0599' });
    for (const [id, alias] of [
      [visible, 'Zichtbaar alias'],
      [hidden, 'Verborgen alias'],
    ] as const)
      await api.query("INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, $2, 'admin')", [id, alias]);
    await api.query("UPDATE museum SET slug = 'tweede-nieuw' WHERE id = $1", [visible2]);
    await api.query("UPDATE museum SET slug = 'verborgen-nieuw' WHERE id = $1", [hidden]);
  });

  it('shows every visible museum, with its municipality, province and folded names', async () => {
    const { rows } = await api.query(
      `SELECT id, slug, municipality_name, province_code, name_folded, sort_name, mk_list_member
         FROM pub_museum ORDER BY slug`,
    );
    // nothing is hidden yet: all four museums are there
    expect(rows.map((r) => r.id).sort()).toEqual([visible, visible2, noMunicipality, hidden].sort());
    expect(rows.find((r) => r.id === visible)).toEqual({
      id: visible,
      slug: 'zichtbaar',
      municipality_name: 'Amsterdam',
      province_code: 'NL-NH',
      name_folded: 'Kroller Zichtbaar',
      sort_name: 'kroller zichtbaar',
      mk_list_member: false,
    });
    expect(rows.find((r) => r.id === noMunicipality)).toMatchObject({ municipality_name: null, province_code: null });
    const doc = await api.query<{ m: boolean }>(
      "SELECT search @@ to_tsquery('pg_catalog.dutch', 'kroller:A') AS m FROM pub_museum WHERE id = $1",
      [visible],
    );
    expect(doc.rows[0]?.m).toBe(true);
  });

  it('hides a museum from pub_museum, pub_museum_alias, pub_slug_redirect and the province counts', async () => {
    expect(await provinceCounts()).toMatchObject({ 'NL-NH': 2, 'NL-ZH': 1 });
    expect(await ids('pub_slug_redirect', 'old_slug')).toEqual(['tweede', 'verborgen-oud']);
    expect((await api.query('SELECT alias FROM pub_museum_alias ORDER BY alias')).rows).toEqual([
      { alias: 'Verborgen alias' },
      { alias: 'Zichtbaar alias' },
    ]);

    await api.query('UPDATE museum SET hidden = true WHERE id = $1', [hidden]);

    expect(await ids('pub_museum')).not.toContain(hidden);
    expect(await ids('pub_museum')).toEqual([visible, visible2, noMunicipality].sort());
    expect(await ids('pub_museum_alias', 'museum_id')).toEqual([visible]);
    expect(await ids('pub_slug_redirect', 'old_slug')).toEqual(['tweede']);
    expect(await provinceCounts()).toMatchObject({ 'NL-NH': 2, 'NL-ZH': 0 });
    // the same through mjk_ssr: it sees exactly what the api sees
    expect((await ssr.query('SELECT id FROM pub_museum WHERE id = $1', [hidden])).rows).toEqual([]);

    await api.query('UPDATE museum SET hidden = false WHERE id = $1', [hidden]);
    expect(await ids('pub_museum')).toContain(hidden);
    expect(await provinceCounts()).toMatchObject({ 'NL-ZH': 1 });
    await api.query('UPDATE museum SET hidden = true WHERE id = $1', [hidden]);
  });

  it('pub_slug_redirect maps an old slug to the current one, never a row equal to the current slug', async () => {
    expect((await api.query('SELECT old_slug, slug FROM pub_slug_redirect')).rows).toEqual([
      { old_slug: 'tweede', slug: 'tweede-nieuw' },
    ]);
    await api.query("UPDATE museum SET slug = 'tweede' WHERE id = $1", [visible2]); // takes its old slug back
    expect(await ids('pub_slug_redirect', 'old_slug')).toEqual(['tweede-nieuw']);
    await api.query("UPDATE museum SET slug = 'tweede-nieuw' WHERE id = $1", [visible2]);
    expect(await ids('pub_slug_redirect', 'old_slug')).toEqual(['tweede']);
  });

  it('pub_province has all 12 provinces with integer counts', async () => {
    const { rows } = await api.query<{ code: string; name_nl: string; name_en: string; museum_count: number }>(
      'SELECT code, name_nl, name_en, museum_count FROM pub_province ORDER BY code',
    );
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => Number.isInteger(r.museum_count))).toBe(true);
    expect(rows.find((r) => r.code === 'NL-FR')).toEqual({
      code: 'NL-FR',
      name_nl: 'Fryslân',
      name_en: 'Friesland',
      museum_count: 0,
    });
    const { rows: type } = await owner.query<{ t: string }>(
      "SELECT format_type(atttypid, NULL) AS t FROM pg_attribute WHERE attrelid = 'pub_province'::regclass AND attname = 'museum_count'",
    );
    expect(type[0]?.t).toBe('integer');
  });

  it('pub_mk_list is empty before a published version, then holds the newest version and its member count', async () => {
    expect((await api.query('SELECT * FROM pub_mk_list')).rows).toEqual([]);
    expect(
      (await api.query<{ m: boolean }>('SELECT mk_list_member AS m FROM pub_museum')).rows.every((r) => !r.m),
    ).toBe(true);

    const version = async (publishedOn: string, members: string[]) => {
      const r = await api.query<{ id: string }>('INSERT INTO mk_list_version (published_on) VALUES ($1) RETURNING id', [
        publishedOn,
      ]);
      for (const m of members)
        await api.query('INSERT INTO mk_list_member (list_version_id, museum_id) VALUES ($1, $2)', [r.rows[0]?.id, m]);
    };
    const memberIds = async () =>
      (await api.query<{ id: string }>('SELECT id FROM pub_museum WHERE mk_list_member ORDER BY id')).rows.map(
        (r) => r.id,
      );
    const list = async () =>
      (
        await api.query<{ published_on: string; n: number }>(
          'SELECT published_on::text AS published_on, n FROM pub_mk_list',
        )
      ).rows;

    await version('2026-01-01', [noMunicipality]);
    expect(await list()).toEqual([{ published_on: '2026-01-01', n: 1 }]);
    expect(await memberIds()).toEqual([noMunicipality]);

    // N stays as published: the hidden museum is counted, but is not in pub_museum
    await version('2026-06-01', [visible, visible2, hidden]);
    expect(await list()).toEqual([{ published_on: '2026-06-01', n: 3 }]);
    expect(await memberIds()).toEqual([visible, visible2].sort());
    expect((await ssr.query('SELECT n FROM pub_mk_list')).rows).toEqual([{ n: 3 }]);
  });
});

describe('the planner', () => {
  it('uses the GIN indexes through the views (no security barrier)', async () => {
    await api.query('SET enable_seqscan = off');
    const plan = async (sql: string) =>
      (await api.query<Record<string, string>>(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    try {
      expect(
        await plan("SELECT id FROM pub_museum WHERE search @@ plainto_tsquery('pg_catalog.dutch', 'kroller')"),
      ).toContain('museum_search_idx');
      expect(await plan("SELECT id FROM pub_museum WHERE 'kroller' <% name_folded")).toContain('museum_name_trgm_idx');
      expect(await plan("SELECT museum_id FROM pub_museum_alias WHERE 'kroller' <% alias_folded")).toContain(
        'museum_alias_trgm_idx',
      );
      expect(await plan('SELECT id FROM pub_museum ORDER BY sort_name, id LIMIT 10')).toContain('museum_sort_idx');
    } finally {
      await api.query('RESET enable_seqscan');
    }
  });
});
