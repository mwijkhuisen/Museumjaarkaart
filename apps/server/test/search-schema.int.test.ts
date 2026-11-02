import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// P1b (db/migrations/20261103000001_search.sql): the immutable unaccent wrapper, the
// trigger-kept `search` document, the five indexes and the old-slug redirects. Rows are
// written as mjk_api or mjk_worker; the superuser-like mjk_migrator only reads the catalog
// (the same pattern as grants.int.test.ts).

let db: TestDb;
const clients: pg.Client[] = [];
let owner: pg.Client;
let api: pg.Client;
let worker: pg.Client;
let ssr: pg.Client;
let n = 0;

const DENIED = '42501';
const UNIQUE = '23505';

const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
/** One statement in a transaction that is always rolled back: 'ok' or its SQLSTATE. */
async function attempt(c: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  await c.query('BEGIN');
  try {
    await c.query(sql, params);
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    await c.query('ROLLBACK');
  }
}
const newMuseum = async (c: pg.Client, row: Record<string, unknown> = {}) => {
  const full = { slug: `s-${n++}`, name: 'Museum', ...row };
  const cols = Object.keys(full);
  const res = await c.query<{ id: string }>(
    `INSERT INTO museum (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(full),
  );
  return (res.rows[0] as { id: string }).id;
};
/** Does the museum's document hold `term` with one of `weights`? to_tsquery stems like the trigger did. */
const has = async (id: string, term: string, weights: string) =>
  (
    await worker.query<{ m: boolean }>(
      "SELECT search @@ to_tsquery('pg_catalog.dutch', $2) AS m FROM museum WHERE id = $1",
      [id, `${term}:${weights}`],
    )
  ).rows[0]?.m;
const xminOf = async (id: string) =>
  (await worker.query<{ x: string }>('SELECT xmin::text AS x FROM museum WHERE id = $1', [id])).rows[0]?.x;

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

describe('mjk_unaccent', () => {
  it('is IMMUTABLE, STRICT and PARALLEL SAFE, and folds accents', async () => {
    const { rows } = await owner.query<{ vol: string; strict: boolean; par: string; owner: string; secdef: boolean }>(
      `SELECT provolatile AS vol, proisstrict AS strict, proparallel AS par,
              pg_get_userbyid(proowner) AS owner, prosecdef AS secdef
         FROM pg_proc WHERE proname = 'mjk_unaccent' AND pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([{ vol: 'i', strict: true, par: 's', owner: 'mjk_migrator', secdef: false }]);
    const r = await api.query<{ a: string; b: string | null }>(
      "SELECT mjk_unaccent('Kröller-Müller') AS a, mjk_unaccent(NULL) AS b",
    );
    expect(r.rows[0]).toEqual({ a: 'Kroller-Muller', b: null });
  });

  it('is callable by every login (PUBLIC keeps EXECUTE)', async () => {
    for (const c of [api, worker, ssr])
      expect((await c.query<{ r: string }>("SELECT mjk_unaccent('Één') AS r")).rows[0]?.r).toBe('Een');
  });
});

describe('the search document', () => {
  it('holds the name (A) of a museum inserted by mjk_worker', async () => {
    const id = await newMuseum(worker, { name: 'Kröller Hoogeveen' });
    expect(await has(id, 'kroller', 'A')).toBe(true);
    expect(await has(id, 'hoogeveen', 'A')).toBe(true);
    expect(await has(id, 'kroller', 'BCD')).toBe(false);
    const { rows } = await worker.query<{ s: string }>('SELECT search::text AS s FROM museum WHERE id = $1', [id]);
    expect(rows[0]?.s).not.toBe('');
  });

  it('holds the English name (B), the aliases (B), the place and the municipality (C)', async () => {
    await worker.query(
      "INSERT INTO municipality (cbs_code, name) VALUES ('GM0900', 'Zuidwolde') ON CONFLICT DO NOTHING",
    );
    const id = await newMuseum(worker, {
      name: 'Tuinhuis',
      name_en: 'Gardenhouse',
      place: 'Otterlo',
      municipality_code: 'GM0900',
    });
    expect(await has(id, 'tuinhuis', 'A')).toBe(true);
    expect(await has(id, 'gardenhouse', 'B')).toBe(true);
    expect(await has(id, 'gardenhouse', 'ACD')).toBe(false);
    expect(await has(id, 'otterlo', 'C')).toBe(true);
    expect(await has(id, 'zuidwolde', 'C')).toBe(true);
    expect(await has(id, 'otterlo', 'ABD')).toBe(false);

    expect(await has(id, 'rijksvilla', 'ABCD')).toBe(false);
    await worker.query("INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Rijksvilla', 'wikidata')", [
      id,
    ]);
    expect(await has(id, 'rijksvilla', 'B')).toBe(true);
    expect(await has(id, 'rijksvilla', 'ACD')).toBe(false);
    // an alias inserted by mjk_api reaches the document as well, and accents are folded
    await api.query("INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Évènement', 'admin')", [id]);
    expect(await has(id, 'evenement', 'B')).toBe(true);
    // the earlier parts are still there
    expect(await has(id, 'tuinhuis', 'A')).toBe(true);
    expect(await has(id, 'zuidwolde', 'C')).toBe(true);
  });

  it('follows a name change and a municipality rename by mjk_worker', async () => {
    await worker.query(
      "INSERT INTO municipality (cbs_code, name) VALUES ('GM0901', 'Noordhorn') ON CONFLICT DO NOTHING",
    );
    const id = await newMuseum(api, { name: 'Oudhuis', municipality_code: 'GM0901' });
    const other = await newMuseum(api, { name: 'Elders' });
    expect(await has(id, 'noordhorn', 'C')).toBe(true);
    const otherX = await xminOf(other);

    await worker.query("UPDATE municipality SET name = 'Zuidhorn' WHERE cbs_code = 'GM0901'");
    expect(await has(id, 'zuidhorn', 'C')).toBe(true);
    expect(await has(id, 'noordhorn', 'C')).toBe(false);
    expect(await has(id, 'oudhuis', 'A')).toBe(true);
    expect(await xminOf(other)).toBe(otherX); // another municipality's museums are not touched

    await api.query("UPDATE museum SET name = 'Nieuwhuis' WHERE id = $1", [id]);
    expect(await has(id, 'nieuwhuis', 'A')).toBe(true);
    expect(await has(id, 'oudhuis', 'ABCD')).toBe(false);
    await api.query("UPDATE museum SET name_en = 'Newhouse', place = 'Dorp' WHERE id = $1", [id]);
    expect(await has(id, 'newhouse', 'B')).toBe(true);
    expect(await has(id, 'dorp', 'C')).toBe(true);
    await api.query('UPDATE museum SET municipality_code = NULL WHERE id = $1', [id]);
    expect(await has(id, 'zuidhorn', 'ABCD')).toBe(false);
  });

  it('leaves the museum row alone when an upsert or an alias insert changes nothing', async () => {
    await worker.query(
      "INSERT INTO municipality (cbs_code, name) VALUES ('GM0902', 'Eenzijde') ON CONFLICT DO NOTHING",
    );
    const id = await newMuseum(worker, { name: 'Stilhuis', place: 'Stil', municipality_code: 'GM0902' });
    await worker.query("INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Stilte', 'wikidata')", [id]);
    const before = await xminOf(id);

    await worker.query(
      `INSERT INTO municipality (cbs_code, name) VALUES ('GM0902', 'Eenzijde')
         ON CONFLICT (cbs_code) DO UPDATE SET name = EXCLUDED.name`,
    );
    expect(await xminOf(id)).toBe(before);
    await worker.query(
      "INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Stilte', 'wikidata') ON CONFLICT DO NOTHING",
      [id],
    );
    expect(await xminOf(id)).toBe(before);
    await api.query(
      "INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Stilte', 'admin') ON CONFLICT DO NOTHING",
      [id],
    );
    expect(await xminOf(id)).toBe(before);

    // a real change does move it
    await worker.query("INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, 'Rust', 'wikidata')", [id]);
    expect(await xminOf(id)).not.toBe(before);
  });

  it('mjk_worker and mjk_api cannot write the column, whatever the statement', async () => {
    const id = await newMuseum(api);
    for (const c of [worker, api]) {
      expect(await attempt(c, "UPDATE museum SET search = 'x'::tsvector WHERE id = $1", [id])).toBe(DENIED);
      expect(await attempt(c, 'UPDATE museum SET search = search WHERE false')).toBe(DENIED);
      expect(await attempt(c, 'UPDATE museum SET search = NULL WHERE id = $1', [id])).toBe(DENIED);
      expect(
        await attempt(c, "INSERT INTO museum (slug, name, search) VALUES ($1, 'M', 'x'::tsvector)", [`z-${n++}`]),
      ).toBe(DENIED);
      expect(
        await attempt(c, 'INSERT INTO museum (slug, name, search) VALUES ($1, $2, DEFAULT)', [`z-${n++}`, 'M']),
      ).toBe(DENIED);
    }
  });

  it('writing a name still recomputes the document in the same statement as the writer', async () => {
    // search is derived, never trusted: the document of an inserted row is never the empty default
    const id = await newMuseum(api, { name: 'Afgeleid' });
    const { rows } = await api.query<{ empty: boolean }>(
      "SELECT search = ''::tsvector AS empty FROM museum WHERE id = $1",
      [id],
    );
    expect(rows[0]?.empty).toBe(false);
  });
});

describe('the trigger functions', () => {
  const FUNCTIONS = [
    'museum_search_refresh',
    'museum_alias_search_touch',
    'municipality_search_touch',
    'museum_slug_keep',
    'museum_slug_guard',
  ];
  const TOUCH = ['museum_alias_search_touch', 'municipality_search_touch'];

  it('are owned by mjk_migrator, pin their search_path and are SECURITY DEFINER only for the touch functions', async () => {
    const { rows } = await owner.query<{
      proname: string;
      owner: string;
      config: string[] | null;
      secdef: boolean;
      lang: string;
      args: number;
    }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.prosecdef AS secdef,
              l.lanname AS lang, p.pronargs::int AS args
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`,
      [FUNCTIONS],
    );
    expect(rows.map((r) => r.proname)).toEqual([...FUNCTIONS].sort());
    for (const r of rows) {
      expect(r.owner, r.proname).toBe('mjk_migrator');
      expect(r.config, r.proname).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(r.lang, r.proname).toBe('plpgsql');
      expect(r.args, r.proname).toBe(0);
      expect(r.secdef, r.proname).toBe(TOUCH.includes(r.proname));
    }
  });

  it('nobody but the owner may EXECUTE the touch functions', async () => {
    for (const fn of TOUCH)
      for (const login of ['mjk_api', 'mjk_worker', 'mjk_ssr', 'mjk_backup', 'mjk_migrator']) {
        const { rows } = await owner.query<{ has: boolean }>('SELECT has_function_privilege($1, $2, $3) AS has', [
          login,
          `public.${fn}()`,
          'EXECUTE',
        ]);
        expect(rows[0]?.has, `${login} ${fn}`).toBe(login === 'mjk_migrator');
      }
    // and a call as mjk_api is refused outright
    expect(await attempt(api, 'SELECT public.museum_alias_search_touch()')).toBe(DENIED);
  });

  it('the triggers exist with the documented timing and events', async () => {
    const { rows } = await owner.query<{ tgname: string; def: string }>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgname = ANY($1) ORDER BY t.tgname`,
      [
        [
          'museum_search_refresh',
          'museum_alias_search_touch_ins_del',
          'museum_alias_search_touch_upd',
          'municipality_search_touch',
          'museum_slug_keep',
          'museum_slug_guard',
        ],
      ],
    );
    const def = Object.fromEntries(rows.map((r) => [r.tgname, r.def.replaceAll('public.', '')]));
    expect(def.museum_search_refresh).toContain(
      'BEFORE INSERT OR UPDATE OF name, name_en, place, municipality_code, search ON museum FOR EACH ROW',
    );
    expect(def.museum_alias_search_touch_ins_del).toContain('AFTER INSERT OR DELETE ON museum_alias FOR EACH ROW');
    expect(def.museum_alias_search_touch_upd).toContain(
      'AFTER UPDATE OF alias, museum_id ON museum_alias FOR EACH ROW',
    );
    expect(def.municipality_search_touch).toContain('AFTER UPDATE OF name ON municipality FOR EACH ROW');
    expect(def.municipality_search_touch).toContain('WHEN ((old.name IS DISTINCT FROM new.name))');
    expect(def.museum_slug_keep).toContain('AFTER UPDATE OF slug ON museum FOR EACH ROW');
    expect(def.museum_slug_guard).toContain('BEFORE INSERT OR UPDATE OF slug ON museum FOR EACH ROW');
  });
});

describe('old-slug redirects', () => {
  const redirects = async (id: string) =>
    (
      await owner.query<{ old_slug: string }>(
        'SELECT old_slug FROM museum_slug_redirect WHERE museum_id = $1 ORDER BY old_slug',
        [id],
      )
    ).rows.map((r) => r.old_slug);
  const setSlug = (id: string, slug: string) => api.query('UPDATE museum SET slug = $2 WHERE id = $1', [id, slug]);

  it('keeps every old slug, pointing at the museum (no chain), and lets a museum take its own back', async () => {
    const id = await newMuseum(api, { slug: 'red-a' });
    expect(await redirects(id)).toEqual([]);
    await setSlug(id, 'red-b');
    expect(await redirects(id)).toEqual(['red-a']);
    await setSlug(id, 'red-c');
    expect(await redirects(id)).toEqual(['red-a', 'red-b']);
    await setSlug(id, 'red-a'); // its own old slug; the one it leaves is kept too
    expect(await redirects(id)).toEqual(['red-a', 'red-b', 'red-c']);
    await setSlug(id, 'red-d'); // 'red-a' is already kept: ON CONFLICT DO NOTHING
    expect(await redirects(id)).toEqual(['red-a', 'red-b', 'red-c']);
    // a no-op slug write keeps nothing
    await setSlug(id, 'red-d');
    expect(await redirects(id)).toEqual(['red-a', 'red-b', 'red-c']);
  });

  it('refuses another museum an old slug, by UPDATE or INSERT, with a fixed message', async () => {
    const id = await newMuseum(api, { slug: 'taken-a' });
    await setSlug(id, 'taken-b');
    const other = await newMuseum(api, { slug: 'taken-x' });

    expect(await attempt(api, 'UPDATE museum SET slug = $2 WHERE id = $1', [other, 'taken-a'])).toBe(UNIQUE);
    expect(await attempt(api, "INSERT INTO museum (slug, name) VALUES ('taken-a', 'M')")).toBe(UNIQUE);
    expect(await attempt(worker, "INSERT INTO museum (slug, name) VALUES ('taken-a', 'M')")).toBe(UNIQUE);

    const err = await api.query('UPDATE museum SET slug = $2 WHERE id = $1', [other, 'taken-a']).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
    expect(err?.code).toBe(UNIQUE);
    expect(err?.message).toBe('museum_slug_taken'); // never the slug itself
    // the refused statement left nothing behind
    expect(await redirects(other)).toEqual([]);
    expect(await attempt(api, 'UPDATE museum SET slug = $2 WHERE id = $1', [other, 'taken-fresh'])).toBe('ok');
  });

  it('only mjk_api can change a slug; mjk_worker and mjk_ssr cannot even read the table', async () => {
    const id = await newMuseum(api, { slug: 'who-a' });
    expect(await attempt(worker, 'UPDATE museum SET slug = $2 WHERE id = $1', [id, 'who-b'])).toBe(DENIED);
    expect(await attempt(worker, 'SELECT 1 FROM museum_slug_redirect')).toBe('ok');
    expect(await attempt(ssr, 'SELECT 1 FROM museum_slug_redirect')).toBe(DENIED);
    expect(await attempt(api, 'UPDATE museum_slug_redirect SET museum_id = museum_id WHERE false')).toBe(DENIED);
    expect(await attempt(api, 'DELETE FROM museum_slug_redirect')).toBe(DENIED);
  });

  it('old_slug has the slug format and the table points at a museum', async () => {
    const id = await newMuseum(api);
    expect(
      await attempt(api, "INSERT INTO museum_slug_redirect (old_slug, museum_id) VALUES ('Bad Slug', $1)", [id]),
    ).toBe('23514');
    expect(
      await attempt(
        api,
        "INSERT INTO museum_slug_redirect (old_slug, museum_id) VALUES ('ok-slug', '0197f0a2-0000-7000-8000-000000000001')",
      ),
    ).toBe('23503');
  });
});

describe('indexes', () => {
  it('the five indexes exist with their definitions', async () => {
    const { rows } = await owner.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [['museum_search_idx', 'museum_name_trgm_idx', 'museum_alias_trgm_idx', 'museum_sort_idx', 'museum_lat_lon_idx']],
    );
    const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replaceAll('public.', '')]));
    expect(def).toEqual({
      museum_search_idx: 'CREATE INDEX museum_search_idx ON museum USING gin (search)',
      museum_name_trgm_idx: 'CREATE INDEX museum_name_trgm_idx ON museum USING gin (mjk_unaccent(name) gin_trgm_ops)',
      museum_alias_trgm_idx:
        'CREATE INDEX museum_alias_trgm_idx ON museum_alias USING gin (mjk_unaccent(alias) gin_trgm_ops)',
      museum_sort_idx: 'CREATE INDEX museum_sort_idx ON museum USING btree (lower(mjk_unaccent(name)), id)',
      museum_lat_lon_idx: 'CREATE INDEX museum_lat_lon_idx ON museum USING btree (lat, lon)',
    });
  });
});
