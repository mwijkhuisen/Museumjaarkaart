import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CBS_CODE,
  CHANGE_FIELDS,
  LIMITS,
  MUSEUMKAART_STATUSES,
  NL_BOX,
  PHOTO_POLICIES,
  POSTCODE,
  PROVINCE_CODE,
  QID,
  SAFE_FIELDS,
  SOURCE_FIELDS,
  WORKER_INSERT_FIELDS,
} from '../src/museums/fields.ts';
import { createMigratedDb, type TestDb } from './db.ts';

// A§8 "Each phase grants its own tables": the P1a grant matrix, proven through the
// catalog and through real statements as each login, plus the CHECK lists that
// must equal apps/server/src/museums/fields.ts.

const TABLES = [
  'province',
  'municipality',
  'museum',
  'museum_alias',
  'museum_sync_run',
  'museum_source_row',
  'museum_change',
  'mk_list_version',
  'mk_list_member',
  'job',
  'museum_slug_redirect',
] as const;
const VIEW = 'mk_list';
// P2a: accounts and the auth tables (db/migrations/20261127000001_accounts.sql).
const AUTH_TABLES = [
  'invite',
  'app_user',
  'session',
  'email_code',
  'auth_challenge',
  'rate_limit',
  'audit_log',
  'content_ip_log',
  'passkey', // P2b (db/migrations/20261128000001_passkeys.sql)
] as const;
// P2c: the passport tables (db/migrations/20261128000002_passport.sql).
const PASSPORT_TABLES = ['visit', 'wishlist', 'visit_import', 'data_export'] as const;
// P3a: ratings and reviews (db/migrations/20261129000001_reviews.sql).
const REVIEW_TABLES = ['review', 'review_revision', 'museum_stats'] as const;
// P3b: photos and the Commons image (db/migrations/20261130000001_media.sql).
const MEDIA_TABLES = ['media', 'media_chunk', 'media_variant', 'blocked_hash', 'museum_image'] as const;
const P1A = [...TABLES, VIEW];
const ALL = [...P1A, ...AUTH_TABLES, ...PASSPORT_TABLES, ...REVIEW_TABLES, ...MEDIA_TABLES];
// P1b's public views: the only objects mjk_ssr may read (A§8).
const PUB_VIEWS = [
  'pub_museum',
  'pub_museum_alias',
  'pub_slug_redirect',
  'pub_province',
  'pub_mk_list',
  'pub_profile',
  'pub_mk_list_province',
  'pub_museum_stats', // P3a
  'pub_media', // P3b
  'pub_museum_image', // P3b
] as const;
const PUB_SELECT = Object.fromEntries(PUB_VIEWS.map((v) => [v, ['SELECT']]));
const LOGINS = ['mjk_api', 'mjk_worker', 'mjk_ssr', 'mjk_backup'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const DENIED = '42501';
const CHECK = '23514';

/** The table-level privileges each login holds (the rest are column grants, tested below). */
const TABLE_LEVEL: Record<(typeof LOGINS)[number], Record<string, readonly string[]>> = {
  mjk_worker: {
    ...Object.fromEntries(P1A.map((t) => [t, ['SELECT']])),
    municipality: ['SELECT', 'INSERT', 'UPDATE'],
    museum_source_row: ['SELECT', 'INSERT', 'UPDATE'],
    museum_sync_run: ['SELECT', 'INSERT', 'UPDATE'],
    job: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], // DELETE since P2a: the purge and the mail jobs
    museum_alias: ['SELECT', 'INSERT'],
    // P2a: column grants only (below) except these
    session: ['DELETE'],
    email_code: ['DELETE'],
    auth_challenge: ['DELETE'],
    rate_limit: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    invite: ['DELETE'],
    content_ip_log: ['DELETE'],
    audit_log: ['INSERT'],
    // P2c: the export job and the purges
    visit: ['SELECT'],
    wishlist: ['SELECT'],
    visit_import: ['SELECT', 'DELETE'],
    data_export: ['SELECT', 'DELETE'],
    // P3a: the stats job reads the reviews and writes the scores
    review: ['SELECT'],
    review_revision: ['SELECT'],
    museum_stats: ['SELECT', 'INSERT', 'UPDATE'],
    // P3b: processing and publishing; museum_image is the Commons sync's
    media: ['SELECT', 'DELETE'],
    media_variant: ['SELECT', 'INSERT', 'DELETE'],
    museum_image: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  mjk_api: {
    ...Object.fromEntries(P1A.map((t) => [t, ['SELECT']])),
    ...PUB_SELECT,
    museum_alias: ['SELECT', 'INSERT'],
    // museum_slug_redirect: SELECT only; the definer trigger museum_slug_keep writes it
    museum_change: ['SELECT', 'INSERT'],
    mk_list_version: ['SELECT', 'INSERT'],
    mk_list_member: ['SELECT', 'INSERT'],
    job: ['SELECT', 'INSERT'],
    app_user: ['SELECT', 'INSERT'],
    session: ['SELECT', 'INSERT', 'DELETE'],
    email_code: ['SELECT', 'INSERT', 'DELETE'],
    auth_challenge: ['SELECT', 'INSERT'],
    invite: ['SELECT', 'INSERT'],
    rate_limit: ['SELECT', 'INSERT', 'UPDATE'],
    audit_log: ['SELECT', 'INSERT'],
    content_ip_log: ['INSERT'],
    passkey: ['SELECT', 'INSERT', 'DELETE'], // P2b
    visit: ['SELECT', 'INSERT', 'DELETE'],
    wishlist: ['SELECT', 'INSERT', 'DELETE'],
    visit_import: ['SELECT', 'INSERT', 'DELETE'],
    data_export: ['SELECT', 'INSERT'],
    review: ['SELECT', 'INSERT', 'DELETE'], // P3a
    review_revision: ['INSERT'],
    // P3b: the upload and moderation paths (column grants below)
    media: ['SELECT', 'INSERT', 'DELETE'],
    media_chunk: ['SELECT', 'INSERT', 'DELETE'],
    media_variant: ['SELECT'],
    blocked_hash: ['SELECT'],
    museum_image: ['SELECT'],
  },
  mjk_ssr: { ...PUB_SELECT },
  // pg_read_all_data: SELECT on everything and nothing else
  mjk_backup: Object.fromEntries([...ALL, ...PUB_VIEWS].map((t) => [t, ['SELECT']])),
};

let db: TestDb;
const clients: pg.Client[] = [];
let owner: pg.Client;
let api: pg.Client;
let worker: pg.Client;
let ssr: pg.Client;
let backup: pg.Client;
let n = 0;
/** A real app_user for the actor foreign keys (P2a), made as the owner: no login may write it freely. */
let actorId: string;
const newUser = async () => {
  const k = n++;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version, terms_accepted_at)
     VALUES ($1, now(), $2, 'U', now(), 'v1', now()) RETURNING id`,
    [`u${k}@example.org`, `user_${k}`],
  );
  return (rows[0] as { id: string }).id;
};

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
const insertSql = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    params: Object.values(row),
  };
};
const insertAs = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const q = insertSql(table, row);
  return attempt(c, q.sql, q.params);
};
const museumRow = (extra: Record<string, unknown> = {}) => ({ slug: `m-${n++}`, name: 'Museum', ...extra });
const newMuseum = async (c: pg.Client, extra: Record<string, unknown> = {}) => {
  const q = insertSql('museum', museumRow(extra));
  return ((await c.query<{ id: string }>(`${q.sql} RETURNING id`, q.params)).rows[0] as { id: string }).id;
};
const columnsOf = async (table: string) =>
  (
    await owner.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table],
    )
  ).rows.map((r) => r.column_name);
/** The columns a login holds a column-level privilege on, as the owner (the grantor) sees them. */
const columnGrants = async (login: string, table: string, privilege: 'INSERT' | 'UPDATE') =>
  (
    await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3`,
      [table, login, privilege],
    )
  ).rows
    .map((r) => r.column_name)
    .sort();
const sorted = (xs: readonly string[]) => [...xs].sort();

beforeAll(async () => {
  db = await createMigratedDb();
  owner = await connect(db.urls.mjk_migrator);
  api = await connect(db.urls.mjk_api);
  worker = await connect(db.urls.mjk_worker);
  ssr = await connect(db.urls.mjk_ssr);
  backup = await connect(db.urls.mjk_backup);
  actorId = await newUser();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('the catalog', () => {
  it('table-level privileges match the matrix, and nobody holds TRUNCATE, REFERENCES or TRIGGER', async () => {
    for (const login of LOGINS) {
      for (const table of [...ALL, ...PUB_VIEWS]) {
        const expected = TABLE_LEVEL[login][table] ?? [];
        const { rows } = await owner.query<{ priv: string; has: boolean }>(
          'SELECT p AS priv, has_table_privilege($1, $2, p) AS has FROM unnest($3::text[]) AS p',
          [login, `public.${table}`, [...PRIVS]],
        );
        const held = rows.filter((r) => r.has).map((r) => r.priv);
        // a view has no INSERT/UPDATE here; TRUNCATE and TRIGGER on it are reported as false as well
        expect(sorted(held), `${login} on ${table}`).toEqual(sorted(expected));
      }
    }
  });

  it('no login holds a column-level REFERENCES, and no sequence is granted', async () => {
    for (const login of LOGINS) {
      for (const table of [...TABLES, ...AUTH_TABLES, ...PASSPORT_TABLES, ...REVIEW_TABLES, ...MEDIA_TABLES]) {
        const { rows } = await owner.query<{ has: boolean }>(
          "SELECT has_any_column_privilege($1, $2, 'REFERENCES') AS has",
          [login, `public.${table}`],
        );
        expect(rows[0]?.has, `${login} on ${table}`).toBe(false);
      }
      const { rows } = await owner.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
          WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace
            AND (has_sequence_privilege($1, c.oid, 'USAGE') OR has_sequence_privilege($1, c.oid, 'UPDATE'))`,
        [login],
      );
      expect(rows, login).toEqual([]);
    }
  });

  it('mjk_worker holds exactly WORKER_INSERT_FIELDS and SAFE_FIELDS on museum', async () => {
    expect(await columnGrants('mjk_worker', 'museum', 'INSERT')).toEqual(sorted(WORKER_INSERT_FIELDS));
    expect(await columnGrants('mjk_worker', 'museum', 'UPDATE')).toEqual(sorted(SAFE_FIELDS));
  });

  it('mjk_api holds every museum column but id, search, created_at and updated_at', async () => {
    const cols = (await columnsOf('museum')).filter((c) => !['id', 'search', 'created_at', 'updated_at'].includes(c));
    expect(cols).toContain('museumkaart_status');
    expect(await columnsOf('museum')).toContain('search');
    expect(await columnGrants('mjk_api', 'museum', 'INSERT')).toEqual(sorted(cols));
    expect(await columnGrants('mjk_api', 'museum', 'UPDATE')).toEqual(sorted(cols));
  });

  it('no login holds any write privilege on museum.search (the triggers keep it)', async () => {
    for (const login of LOGINS) {
      for (const priv of ['INSERT', 'UPDATE', 'REFERENCES'] as const) {
        const { rows } = await owner.query<{ has: boolean }>('SELECT has_column_privilege($1, $2, $3, $4) AS has', [
          login,
          'public.museum',
          'search',
          priv,
        ]);
        expect(rows[0]?.has, `${login} ${priv} on museum.search`).toBe(false);
      }
    }
    expect(await columnGrants('mjk_worker', 'museum', 'INSERT')).not.toContain('search');
    expect(await columnGrants('mjk_worker', 'museum', 'UPDATE')).not.toContain('search');
  });

  it('EXECUTE on the public functions: pub_search, pub_visit_log, pub_wishlist_of and the three pub_review functions for mjk_api and mjk_ssr, the definer triggers for nobody', async () => {
    const EXECUTE: Record<string, readonly string[]> = {
      'public.pub_search(text)': ['mjk_api', 'mjk_ssr'],
      'public.pub_visit_log(text)': ['mjk_api', 'mjk_ssr'],
      'public.pub_wishlist_of(text)': ['mjk_api', 'mjk_ssr'],
      'public.pub_review(uuid)': ['mjk_api', 'mjk_ssr'],
      'public.pub_reviews_of_museum(uuid, uuid, integer)': ['mjk_api', 'mjk_ssr'],
      'public.pub_reviews_of_user(text, uuid, integer)': ['mjk_api', 'mjk_ssr'],
      'public.museum_slug_keep()': [],
      'public.museum_alias_search_touch()': [],
      'public.municipality_search_touch()': [],
    };
    for (const [fn, allowed] of Object.entries(EXECUTE))
      for (const login of LOGINS) {
        const { rows } = await owner.query<{ has: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS has",
          [login, fn],
        );
        // mjk_backup holds pg_read_all_data, which grants no EXECUTE
        expect(rows[0]?.has, `${login} ${fn}`).toBe(allowed.includes(login));
      }
  });

  it('column grants on museum_change and museum_source_row', async () => {
    const change = await columnsOf('museum_change');
    expect(await columnGrants('mjk_worker', 'museum_change', 'INSERT')).toEqual(
      sorted(change.filter((c) => !['id', 'created_at', 'origin', 'reporter_id', 'decided_by'].includes(c))),
    );
    expect(await columnGrants('mjk_worker', 'museum_change', 'UPDATE')).toEqual(['decided_at', 'state']);
    expect(await columnGrants('mjk_api', 'museum_change', 'UPDATE')).toEqual(['decided_at', 'decided_by', 'state']);
    expect(await columnGrants('mjk_api', 'museum_source_row', 'UPDATE')).toEqual(
      sorted(['candidate_ids', 'match_reason', 'match_rule', 'match_state', 'matched_museum_id']),
    );
  });
});

describe('CHECK lists equal fields.ts', () => {
  const defs = new Map<string, string>();
  beforeAll(async () => {
    const { rows } = await owner.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
    );
    for (const r of rows) defs.set(r.conname, r.def);
  });
  const def = (name: string) => {
    const d = defs.get(name);
    expect(d, `constraint ${name}`).toBeDefined();
    return d as string;
  };
  /** The single-quoted words of a constraint, in order. */
  const words = (name: string) => [...def(name).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);

  it('categories, museumkaart_status, photo_policy, pinned_fields and museum_change.field', () => {
    expect(sorted(words('museum_categories_check'))).toEqual(sorted(CATEGORIES));
    expect(sorted(words('museum_museumkaart_status_check'))).toEqual(sorted(MUSEUMKAART_STATUSES));
    expect(sorted(words('museum_photo_policy_check'))).toEqual(sorted(PHOTO_POLICIES));
    expect(sorted(words('museum_pinned_fields_check'))).toEqual(sorted(SOURCE_FIELDS));
    expect(sorted(words('museum_change_field_check'))).toEqual(sorted(CHANGE_FIELDS));
  });

  it('the key formats and the NL box', () => {
    expect(def('museum_wikidata_qid_check')).toContain(`'${QID.source}'`);
    expect(def('museum_postcode_check')).toContain(`'${POSTCODE.source}'`);
    expect(def('municipality_cbs_code_check')).toContain(`'${CBS_CODE.source}'`);
    expect(def('province_code_check')).toContain(`'${PROVINCE_CODE.source}'`);
    expect(def('museum_rce_id_check')).toContain(`{1,${LIMITS.rceId}}`);
    const box = def('museum_coordinates_check');
    const { latMin, latMax, lonMin, lonMax } = NL_BOX;
    for (const [col, op, v] of [
      ['lat', '>=', latMin],
      ['lat', '<=', latMax],
      ['lon', '>=', lonMin],
      ['lon', '<=', lonMax],
    ] as const)
      expect(box).toContain(`${col} ${op} (${v})::double precision`);
  });

  it('the length caps', () => {
    const caps: [string, string, number][] = [
      ['museum_name_check', 'name', LIMITS.label],
      ['museum_name_en_check', 'name_en', LIMITS.label],
      ['museum_description_nl_check', 'description_nl', LIMITS.description],
      ['museum_description_en_check', 'description_en', LIMITS.description],
      ['museum_alias_alias_check', 'alias', LIMITS.alias],
      ['museum_street_check', 'street', LIMITS.street],
      ['museum_house_number_check', 'house_number', LIMITS.houseNumber],
      ['museum_place_check', 'place', LIMITS.place],
      ['municipality_name_check', 'name', LIMITS.municipalityName],
      ['museum_website_check', 'website', LIMITS.url],
      ['museum_museumnl_url_check', 'museumnl_url', LIMITS.url],
      ['museum_commons_file_check', 'commons_file', LIMITS.commonsFile],
      ['museum_slug_check', 'slug', LIMITS.slug],
    ];
    for (const [name, col, max] of caps)
      expect(def(name), name).toMatch(new RegExp(`char_length\\(${col}\\) <= ${max}\\b`));
  });
});

describe('mjk_worker', () => {
  it('can INSERT a museum with the source fields, and read it back with RETURNING', async () => {
    await worker.query(
      "INSERT INTO municipality (cbs_code, name) VALUES ('GM0363', 'Amsterdam') ON CONFLICT DO NOTHING",
    );
    const row: Record<string, unknown> = {
      slug: `w-${n++}`,
      wikidata_qid: `Q${1000 + n}`,
      rce_id: `rce-${n}`,
      name: 'Museum',
      name_en: 'Museum',
      description_nl: 'd',
      description_en: 'd',
      lat: 52.37,
      lon: 4.89,
      website: 'https://example.org',
      street: 'Straat',
      house_number: '1',
      postcode: '1012 AB',
      place: 'Amsterdam',
      municipality_code: 'GM0363',
      registered: true,
      museumnl_url: 'https://www.museum.nl/nl/x',
      categories: ['art'],
      commons_file: 'X.jpg',
    };
    expect(sorted(Object.keys(row))).toEqual(sorted(WORKER_INSERT_FIELDS));
    const q = insertSql('museum', row);
    const res = await worker.query(`${q.sql} RETURNING id, museumkaart_status`, q.params);
    expect(res.rows[0]).toMatchObject({ museumkaart_status: 'unknown' });
  });

  it('can UPDATE each SAFE_FIELDS column, and only those', async () => {
    const id = await newMuseum(api, { lat: 52.1, lon: 5.1 });
    const value: Record<string, unknown> = {
      rce_id: 'r-9',
      name_en: 'E',
      description_nl: 'd',
      description_en: 'd',
      lat: 52.2,
      lon: 5.2,
      website: 'https://example.org',
      street: 'S',
      house_number: '1',
      postcode: '1234 AB',
      place: 'P',
      municipality_code: 'GM0363',
      registered: true,
      museumnl_url: 'https://www.museum.nl/nl/y',
    };
    expect(sorted(Object.keys(value))).toEqual(sorted(SAFE_FIELDS));
    for (const col of SAFE_FIELDS)
      expect(await code(worker.query(`UPDATE museum SET ${col} = $1 WHERE id = $2`, [value[col], id])), col).toBe('ok');
    const all = await columnsOf('museum');
    for (const col of all.filter((c) => !(SAFE_FIELDS as readonly string[]).includes(c)))
      expect(await attempt(worker, `UPDATE museum SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
  });

  it('cannot UPDATE the curated columns, the name or the QID with a value', async () => {
    const id = await newMuseum(api);
    const attemptSet = (col: string, v: unknown) =>
      attempt(worker, `UPDATE museum SET ${col} = $1 WHERE id = $2`, [v, id]);
    expect(await attemptSet('name', 'Other')).toBe(DENIED);
    expect(await attemptSet('museumkaart_status', 'participating')).toBe(DENIED);
    expect(await attemptSet('mk_since', '2026-01-01')).toBe(DENIED);
    expect(await attemptSet('admission_adult_cents', 1500)).toBe(DENIED);
    expect(await attemptSet('photo_policy', 'allowed')).toBe(DENIED);
    expect(await attemptSet('hidden', true)).toBe(DENIED);
    expect(await attemptSet('pinned_fields', ['name'])).toBe(DENIED);
    expect(await attemptSet('temp_closed', true)).toBe(DENIED);
    expect(await attemptSet('wikidata_qid', 'Q5')).toBe(DENIED);
  });

  it('cannot INSERT a museum that names a curated column or closed_on', async () => {
    expect(await insertAs(worker, 'museum', museumRow({ museumkaart_status: 'participating' }))).toBe(DENIED);
    expect(await insertAs(worker, 'museum', museumRow({ museumkaart_status: 'unknown' }))).toBe(DENIED);
    expect(await insertAs(worker, 'museum', museumRow({ admission_adult_cents: 1500 }))).toBe(DENIED);
    expect(await insertAs(worker, 'museum', museumRow({ hidden: false }))).toBe(DENIED);
    expect(await insertAs(worker, 'museum', museumRow({ closed_on: '2020-01-01' }))).toBe(DENIED);
    const named = new Set(WORKER_INSERT_FIELDS);
    for (const col of (await columnsOf('museum')).filter((c) => !named.has(c) && c !== 'id'))
      expect(
        await attempt(worker, `INSERT INTO museum (slug, name, ${col}) VALUES ($1, $2, DEFAULT)`, [`g-${n++}`, 'M']),
        col,
      ).toBe(DENIED);
  });

  it('museum_change: no origin, reporter_id or decided_by on INSERT; state and decided_at on UPDATE only', async () => {
    const id = await newMuseum(api);
    const base = { museum_id: id, field: 'website', state: 'pending' };
    expect(await insertAs(worker, 'museum_change', base)).toBe('ok');
    expect(await insertAs(worker, 'museum_change', { ...base, origin: 'sync' })).toBe(DENIED);
    expect(
      await insertAs(worker, 'museum_change', { ...base, reporter_id: '0197f0a2-0000-7000-8000-000000000001' }),
    ).toBe(DENIED);
    expect(
      await insertAs(worker, 'museum_change', { ...base, decided_by: '0197f0a2-0000-7000-8000-000000000001' }),
    ).toBe(DENIED);

    const ins = insertSql('museum_change', base);
    const chId = ((await worker.query<{ id: string }>(`${ins.sql} RETURNING id`, ins.params)).rows[0] as { id: string })
      .id;
    expect(
      await code(
        worker.query("UPDATE museum_change SET state = 'superseded', decided_at = now() WHERE id = $1", [chId]),
      ),
    ).toBe('ok');
    for (const col of ['field', 'old', 'new', 'museum_id', 'origin', 'decided_by', 'reporter_id'])
      expect(await attempt(worker, `UPDATE museum_change SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
  });

  it('cannot write the Museumkaart list', async () => {
    expect(await insertAs(worker, 'mk_list_version', { published_on: '2026-01-01' })).toBe(DENIED);
    expect(await attempt(worker, 'UPDATE mk_list_version SET published_on = published_on WHERE false')).toBe(DENIED);
    const id = await newMuseum(api);
    const v = await api.query<{ id: string }>(
      "INSERT INTO mk_list_version (published_on) VALUES ('2026-06-01') RETURNING id",
    );
    const versionId = v.rows[0]?.id;
    expect(await insertAs(worker, 'mk_list_member', { list_version_id: versionId, museum_id: id })).toBe(DENIED);
    expect(await attempt(worker, 'UPDATE mk_list_member SET museum_id = museum_id WHERE false')).toBe(DENIED);
  });

  it('can write its own tables and enqueue a job; cannot write province or alias updates', async () => {
    const run = await worker.query<{ id: string }>("INSERT INTO museum_sync_run (mode) VALUES ('sync') RETURNING id");
    const runId = run.rows[0]?.id;
    expect(
      await code(
        worker.query("UPDATE museum_sync_run SET outcome = 'applied', finished_at = now() WHERE id = $1", [runId]),
      ),
    ).toBe('ok');
    expect(
      await insertAs(worker, 'museum_source_row', {
        source: 'rce',
        external_id: 'e1',
        payload: '{}',
        hash: 'b'.repeat(64),
        run_id: runId,
        match_state: 'new',
      }),
    ).toBe('ok');
    expect(
      await attempt(worker, "UPDATE museum_source_row SET payload = '{}', hash = $1 WHERE false", ['c'.repeat(64)]),
    ).toBe('ok');
    expect(await insertAs(worker, 'job', { kind: 'museum_sync' })).toBe('ok');
    expect(
      await attempt(worker, "UPDATE job SET state = 'running', locked_at = now(), locked_by = 'w' WHERE false"),
    ).toBe('ok');
    const id = await newMuseum(api);
    expect(await insertAs(worker, 'museum_alias', { museum_id: id, alias: 'A', source: 'wikidata' })).toBe('ok');
    expect(await attempt(worker, 'UPDATE museum_alias SET alias = alias WHERE false')).toBe(DENIED);
    expect(await insertAs(worker, 'province', { code: 'NL-XX', name_nl: 'x', name_en: 'x' })).toBe(DENIED);
    expect(await attempt(worker, 'UPDATE province SET name_nl = name_nl WHERE false')).toBe(DENIED);
  });
});

describe('mjk_api', () => {
  it('can INSERT and UPDATE museums with curated columns, but not id or the timestamps', async () => {
    const id = await newMuseum(api, { museumkaart_status: 'participating', photo_policy: 'no_flash', hidden: false });
    for (const [col, v] of [
      ['mk_until', '2026-01-01'], // before 'left', which needs it
      ['museumkaart_status', 'left'],
      ['mk_last_verified_at', new Date()],
      ['admission_adult_cents', 1500],
      ['price_verified_at', new Date()],
      ['photo_policy', 'allowed'],
      ['temp_closed', true],
      ['temp_closed_until', '2027-01-01'],
      ['hidden', true],
      ['pinned_fields', ['name']],
      ['name', 'Nieuw'],
      ['closed_on', '2020-01-01'],
    ] as const)
      expect(await code(api.query(`UPDATE museum SET ${col} = $1 WHERE id = $2`, [v, id])), col).toBe('ok');
    for (const col of ['id', 'created_at', 'updated_at'])
      expect(await attempt(api, `UPDATE museum SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    expect(
      await attempt(api, 'INSERT INTO museum (slug, name, created_at) VALUES ($1, $2, now())', [`x-${n++}`, 'M']),
    ).toBe(DENIED);
  });

  it('can INSERT aliases, changes (with an origin), list versions and members, and jobs', async () => {
    const id = await newMuseum(api);
    expect(await insertAs(api, 'museum_alias', { museum_id: id, alias: 'A', source: 'admin' })).toBe('ok');
    expect(
      await insertAs(api, 'museum_change', {
        museum_id: id,
        field: 'hidden',
        state: 'applied',
        origin: 'admin',
        decided_by: actorId,
      }),
    ).toBe('ok');
    expect(await insertAs(api, 'job', { kind: 'museum_sync' })).toBe('ok');
    const v = await api.query<{ id: string }>(
      "INSERT INTO mk_list_version (published_on) VALUES ('2026-07-01') RETURNING id",
    );
    expect(await insertAs(api, 'mk_list_member', { list_version_id: v.rows[0]?.id, museum_id: id })).toBe('ok');
  });

  it('can UPDATE the match columns of a source row and decide a change, nothing else', async () => {
    const id = await newMuseum(api);
    const run = await worker.query<{ id: string }>("INSERT INTO museum_sync_run (mode) VALUES ('sync') RETURNING id");
    await worker.query(
      "INSERT INTO museum_source_row (source, external_id, payload, hash, run_id, match_state) VALUES ('wikidata', 'Q77', '{}', $1, $2, 'new')",
      ['d'.repeat(64), run.rows[0]?.id],
    );
    expect(
      await code(
        api.query(
          "UPDATE museum_source_row SET matched_museum_id = $1, match_state = 'matched', match_rule = 'admin', match_reason = NULL, candidate_ids = '{}' WHERE source = 'wikidata' AND external_id = 'Q77'",
          [id],
        ),
      ),
    ).toBe('ok');
    for (const col of ['payload', 'hash', 'source', 'external_id', 'run_id', 'fetched_at', 'gone_since_run_id'])
      expect(await attempt(api, `UPDATE museum_source_row SET ${col} = ${col} WHERE false`), col).toBe(DENIED);

    const ins = insertSql('museum_change', { museum_id: id, field: 'website', state: 'pending' });
    const chId = ((await api.query<{ id: string }>(`${ins.sql} RETURNING id`, ins.params)).rows[0] as { id: string })
      .id;
    expect(
      await code(
        api.query("UPDATE museum_change SET state = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1", [
          chId,
          actorId,
        ]),
      ),
    ).toBe('ok');
    for (const col of ['field', 'old', 'new', 'museum_id', 'origin', 'source', 'reporter_id'])
      expect(await attempt(api, `UPDATE museum_change SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
  });

  it('cannot change the list once published, write sync tables, or touch jobs after enqueueing', async () => {
    expect(await attempt(api, 'UPDATE mk_list_version SET published_on = published_on WHERE false')).toBe(DENIED);
    expect(await attempt(api, 'UPDATE mk_list_member SET museum_id = museum_id WHERE false')).toBe(DENIED);
    expect(await attempt(api, 'UPDATE job SET state = state WHERE false')).toBe(DENIED);
    expect(await insertAs(api, 'museum_sync_run', { mode: 'sync' })).toBe(DENIED);
    expect(await insertAs(api, 'municipality', { cbs_code: 'GM0001', name: 'X' })).toBe(DENIED);
    expect(await insertAs(api, 'province', { code: 'NL-XX', name_nl: 'x', name_en: 'x' })).toBe(DENIED);
    expect(await attempt(api, 'UPDATE museum_alias SET alias = alias WHERE false')).toBe(DENIED);
    expect(await attempt(api, 'UPDATE municipality SET name = name WHERE false')).toBe(DENIED);
  });
});

describe('mjk_ssr and mjk_backup', () => {
  it('mjk_ssr cannot SELECT any P1a table or the view, and can SELECT the public views', async () => {
    for (const t of ALL) expect(await code(ssr.query(`SELECT 1 FROM ${t} LIMIT 1`)), t).toBe(DENIED);
    for (const v of PUB_VIEWS) expect(await code(ssr.query(`SELECT 1 FROM ${v} LIMIT 1`)), v).toBe('ok');
  });

  it('mjk_backup can SELECT everything and cannot INSERT, UPDATE or DELETE', async () => {
    for (const t of [...ALL, ...PUB_VIEWS]) expect(await code(backup.query(`SELECT count(*) FROM ${t}`)), t).toBe('ok');
    expect(await insertAs(backup, 'job', { kind: 'museum_sync' })).toBe(DENIED);
    expect(await insertAs(backup, 'museum', museumRow())).toBe(DENIED);
    expect(await attempt(backup, 'UPDATE museum SET name = name WHERE false')).toBe(DENIED);
  });
});

describe('no login can DELETE or TRUNCATE, except the worker on its purge tables', () => {
  // mjk_worker's DELETE grants (P2a): purges and the delete-on-success mail jobs. Never TRUNCATE.
  // P2c adds the import purge and the export purge.
  const WORKER_DELETE = [
    'job',
    'session',
    'email_code',
    'auth_challenge',
    'rate_limit',
    'invite',
    'content_ip_log',
    'visit_import',
    'data_export',
    'media',
    'media_variant',
    'museum_image',
  ];
  it.each(LOGINS)('%s gets 42501 for DELETE and TRUNCATE on every table it holds no DELETE on', async (login) => {
    const c = { mjk_api: api, mjk_worker: worker, mjk_ssr: ssr, mjk_backup: backup }[login];
    for (const t of [...TABLES, ...AUTH_TABLES, ...PASSPORT_TABLES, ...REVIEW_TABLES, ...MEDIA_TABLES]) {
      const mayDelete = login === 'mjk_worker' && WORKER_DELETE.includes(t);
      // mjk_api holds DELETE on session and email_code (sign-out, used codes), passkey (P2b: remove a passkey)
      // and P2c's visit, wishlist and pending import
      const apiDelete =
        login === 'mjk_api' &&
        [
          'session',
          'email_code',
          'passkey',
          'visit',
          'wishlist',
          'visit_import',
          'review',
          'media',
          'media_chunk',
        ].includes(t);
      expect(await attempt(c, `DELETE FROM ${t}`), `${login} DELETE ${t}`).toBe(mayDelete || apiDelete ? 'ok' : DENIED);
      expect(await attempt(c, `TRUNCATE ${t}`), `${login} TRUNCATE ${t}`).toBe(DENIED);
    }
  });
});

describe('P2a: the accounts grants', () => {
  const COLS = {
    mjk_api: {
      app_user: [
        'email',
        'email_verified_at',
        'display_name',
        'password_hash',
        'role',
        'status',
        'banned_until',
        'ban_reason',
        'settings',
        'trusted_at', // P3b: the admin user trust CLI
      ],
      session: ['expires_at', 'last_used_at'],
      email_code: ['attempts', 'used_at'],
      invite: ['uses', 'used_at'],
      passkey: ['name', 'sign_count', 'backed_up', 'last_used_at'], // P2b
    },
  } as const;

  it('mjk_api holds exactly its UPDATE columns on the account tables', async () => {
    for (const [table, cols] of Object.entries(COLS.mjk_api))
      expect(await columnGrants('mjk_api', table, 'UPDATE'), table).toEqual(sorted(cols));
    // table-level UPDATE shows up as every column: none of the P2a tables other than rate_limit may
    for (const table of ['auth_challenge', 'audit_log', 'content_ip_log'])
      expect(await columnGrants('mjk_api', table, 'UPDATE'), table).toEqual([]);
    expect(await columnGrants('mjk_api', 'rate_limit', 'UPDATE')).toEqual(sorted(await columnsOf('rate_limit')));
  });

  it('mjk_worker may SELECT only the listed columns, never password_hash or code_hmac', async () => {
    const SELECT: Record<string, string[]> = {
      // P2c adds the export's columns: never password_hash, never session.id (the token hash)
      app_user: [
        'id',
        'email',
        'handle',
        'display_name',
        'email_verified_at',
        'status',
        'age_confirmed_at',
        'terms_version',
        'terms_accepted_at',
        'settings',
        'created_at',
        'trusted_at', // P3b: the media job's trusted-author check
      ],
      email_code: ['id', 'email', 'purpose', 'expires_at', 'created_at'],
      session: ['user_id', 'host', 'method', 'created_at', 'last_used_at', 'expires_at', 'absolute_expires_at'],
      auth_challenge: ['expires_at'],
      invite: ['id', 'expires_at', 'used_at', 'uses', 'max_uses'],
      content_ip_log: ['user_id', 'target_kind', 'target_id', 'ip', 'created_at'],
      // P2c's export: the passkeys' metadata, never credential_id, public_key, ref or sign_count
      passkey: ['user_id', 'name', 'transports', 'backed_up', 'created_at', 'last_used_at'],
    };
    for (const [table, allowed] of Object.entries(SELECT))
      for (const col of await columnsOf(table)) {
        const { rows } = await owner.query<{ has: boolean }>(
          "SELECT has_column_privilege('mjk_worker', $1, $2, 'SELECT') AS has",
          [`public.${table}`, col],
        );
        expect(rows[0]?.has, `mjk_worker SELECT ${table}.${col}`).toBe(allowed.includes(col));
      }
    for (const [table, col] of [
      ['app_user', 'password_hash'],
      ['email_code', 'code_hmac'],
    ] as const)
      for (const priv of ['INSERT', 'UPDATE'])
        expect(await columnGrants('mjk_worker', table, priv as 'INSERT' | 'UPDATE')).not.toContain(col);
  });

  it('mjk_worker cannot read the hashes or write account rows', async () => {
    expect(await attempt(worker, 'SELECT password_hash FROM app_user')).toBe(DENIED);
    expect(await attempt(worker, 'SELECT code_hmac FROM email_code')).toBe(DENIED);
    expect(await attempt(worker, 'SELECT * FROM app_user')).toBe(DENIED);
    expect(await attempt(worker, 'SELECT email, status FROM app_user')).toBe('ok');
    expect(await attempt(worker, 'SELECT id FROM session')).toBe(DENIED);
    expect(await attempt(worker, "DELETE FROM email_code WHERE expires_at < now() - interval '1 day'")).toBe('ok');
    expect(await attempt(worker, "DELETE FROM job WHERE state = 'done'")).toBe('ok');
    expect(await attempt(worker, 'TRUNCATE job')).toBe(DENIED);
    expect(await attempt(worker, 'DELETE FROM app_user')).toBe(DENIED);
    expect(await attempt(worker, "UPDATE app_user SET status = 'banned' WHERE false")).toBe(DENIED);
    expect(await attempt(worker, 'UPDATE session SET expires_at = expires_at WHERE false')).toBe(DENIED);
    expect(await insertAs(worker, 'audit_log', { actor_kind: 'system', action: 'purge.done' })).toBe('ok');
  });

  it('mjk_api cannot touch the columns it was not given', async () => {
    expect(await attempt(api, "UPDATE app_user SET handle = 'someone_else' WHERE false")).toBe(DENIED);
    for (const col of [
      'id',
      'handle',
      'age_confirmed_at',
      'terms_version',
      'terms_accepted_at',
      'invite_id',
      'created_at',
    ])
      expect(await attempt(api, `UPDATE app_user SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    expect(await attempt(api, "UPDATE invite SET code_hmac = '\\x00' WHERE false")).toBe(DENIED);
    for (const col of ['id', 'ref', 'user_id', 'host', 'method', 'created_at', 'absolute_expires_at', 'reauth_at'])
      expect(await attempt(api, `UPDATE session SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    for (const col of ['code_hmac', 'email', 'purpose', 'expires_at', 'pending'])
      expect(await attempt(api, `UPDATE email_code SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    for (const col of ['max_uses', 'expires_at', 'created_by', 'note'])
      expect(await attempt(api, `UPDATE invite SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    expect(await attempt(api, 'UPDATE auth_challenge SET used_at = now() WHERE false')).toBe(DENIED);
    expect(await attempt(api, 'DELETE FROM app_user')).toBe(DENIED);
    expect(await attempt(api, 'DELETE FROM invite')).toBe(DENIED);
    expect(await attempt(api, 'SELECT 1 FROM content_ip_log')).toBe(DENIED);
  });

  it('P2b: mjk_api cannot UPDATE webauthn_user_id or the passkey key material, and only mjk_api and mjk_backup read them', async () => {
    expect(
      await attempt(api, "UPDATE app_user SET webauthn_user_id = '\\x00112233445566778899aabbccddeeff' WHERE false"),
    ).toBe(DENIED);
    expect(await attempt(api, 'UPDATE app_user SET webauthn_user_id = webauthn_user_id WHERE false')).toBe(DENIED);
    for (const col of ['credential_id', 'user_id', 'public_key', 'ref', 'transports', 'created_at'])
      expect(await attempt(api, `UPDATE passkey SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
    for (const col of ['name', 'sign_count', 'backed_up', 'last_used_at'])
      expect(await attempt(api, `UPDATE passkey SET ${col} = ${col} WHERE false`), col).toBe('ok');
    expect(await attempt(api, 'SELECT webauthn_user_id FROM app_user')).toBe('ok');
    for (const [login, c] of [
      ['mjk_worker', worker],
      ['mjk_ssr', ssr],
    ] as const) {
      expect(await attempt(c, 'SELECT webauthn_user_id FROM app_user'), `${login} webauthn_user_id`).toBe(DENIED);
      for (const col of ['credential_id', 'public_key', 'ref', 'sign_count'])
        expect(await attempt(c, `SELECT ${col} FROM passkey`), `${login} passkey.${col}`).toBe(DENIED);
      expect(await attempt(c, 'DELETE FROM passkey'), `${login} DELETE passkey`).toBe(DENIED);
      expect(await attempt(c, 'UPDATE passkey SET sign_count = 0 WHERE false'), `${login} UPDATE passkey`).toBe(DENIED);
    }
    expect(await attempt(ssr, 'SELECT 1 FROM passkey'), 'mjk_ssr passkey').toBe(DENIED);
    // P2c: the export reads the passkeys' metadata, never the key material.
    expect(
      await attempt(worker, 'SELECT user_id, name, transports, backed_up, created_at, last_used_at FROM passkey'),
    ).toBe('ok');
    // mjk_worker's SELECT on app_user stays (email, status)
    expect(await attempt(worker, 'SELECT email, status FROM app_user')).toBe('ok');
  });

  it('nobody can UPDATE, DELETE or TRUNCATE audit_log', async () => {
    const owners = [
      ['mjk_api', api],
      ['mjk_worker', worker],
      ['mjk_ssr', ssr],
      ['mjk_backup', backup],
    ] as const;
    for (const [login, c] of owners) {
      expect(await attempt(c, "UPDATE audit_log SET action = 'x' WHERE false"), `${login} UPDATE`).toBe(DENIED);
      expect(await attempt(c, 'DELETE FROM audit_log'), `${login} DELETE`).toBe(DENIED);
      expect(await attempt(c, 'TRUNCATE audit_log'), `${login} TRUNCATE`).toBe(DENIED);
    }
  });

  it('mjk_api can run the sign-up flow: user, session, code, challenge, invite, limiter, audit, ip log', async () => {
    const hash = Buffer.alloc(32, 1);
    const user = {
      email: `flow@example.org`,
      email_verified_at: new Date(),
      handle: 'flow_user',
      display_name: 'Flow',
      age_confirmed_at: new Date(),
      terms_version: '2026-11-27',
      terms_accepted_at: new Date(),
    };
    const q = insertSql('app_user', user);
    const id = ((await api.query<{ id: string }>(`${q.sql} RETURNING id`, q.params)).rows[0] as { id: string }).id;
    const future = new Date(Date.now() + 3_600_000);
    expect(
      await insertAs(api, 'session', {
        id: hash,
        user_id: id,
        host: 'public',
        method: 'code',
        expires_at: future,
        absolute_expires_at: future,
      }),
    ).toBe('ok');
    expect(
      await insertAs(api, 'email_code', {
        email: 'Flow@Example.org',
        purpose: 'signin',
        code_hmac: hash,
        expires_at: future,
      }),
    ).toBe('ok');
    expect(
      await insertAs(api, 'auth_challenge', {
        purpose: 'altcha',
        host: 'public',
        value_hash: hash,
        expires_at: future,
      }),
    ).toBe('ok');
    expect(await insertAs(api, 'invite', { code_hmac: hash, created_by: id })).toBe('ok');
    expect(
      await insertAs(api, 'rate_limit', {
        bucket: 'signin',
        key: 'ip:1.2.3.0',
        window_start: new Date(),
        window_end: future,
        count: 1,
      }),
    ).toBe('ok');
    expect(
      await insertAs(api, 'audit_log', {
        actor_id: id,
        actor_kind: 'user',
        action: 'user.signup',
        target_kind: 'user',
        target_id: id,
      }),
    ).toBe('ok');
    expect(
      await insertAs(api, 'content_ip_log', { user_id: id, target_kind: 'review', target_id: id, ip: '203.0.113.7' }),
    ).toBe('ok');
  });

  it('mjk_ssr holds nothing on the new tables', async () => {
    for (const t of AUTH_TABLES) expect(await attempt(ssr, `SELECT 1 FROM ${t} LIMIT 1`), t).toBe(DENIED);
    expect(await attempt(ssr, 'SELECT webauthn_user_id FROM app_user')).toBe(DENIED);
  });
});

describe('P2c: the passport grants', () => {
  it('mjk_api holds exactly its UPDATE columns, mjk_worker only the export and purge columns', async () => {
    expect(await columnGrants('mjk_api', 'visit', 'UPDATE')).toEqual(['note', 'visited_on']);
    expect(await columnGrants('mjk_api', 'visit_import', 'UPDATE')).toEqual(['confirmed_at', 'state']);
    expect(await columnGrants('mjk_api', 'data_export', 'UPDATE')).toEqual(['state']);
    expect(await columnGrants('mjk_api', 'wishlist', 'UPDATE')).toEqual([]);
    expect(await columnGrants('mjk_worker', 'data_export', 'UPDATE')).toEqual(['expires_at', 'state']);
    for (const t of ['visit', 'wishlist', 'visit_import'])
      expect(await columnGrants('mjk_worker', t, 'UPDATE'), t).toEqual([]);
    for (const t of PASSPORT_TABLES) expect(await columnGrants('mjk_worker', t, 'INSERT'), t).toEqual([]);
    // the api cannot move a visit to another member or museum, or change its source
    for (const col of ['id', 'user_id', 'museum_id', 'source', 'created_at'])
      expect(await attempt(api, `UPDATE visit SET ${col} = ${col} WHERE false`), col).toBe(DENIED);
  });

  it('mjk_ssr holds nothing on the passport tables, and can run the views and functions', async () => {
    for (const t of PASSPORT_TABLES) expect(await attempt(ssr, `SELECT 1 FROM ${t} LIMIT 1`), t).toBe(DENIED);
    expect(await attempt(ssr, "SELECT * FROM pub_visit_log('nobody')")).toBe('ok');
    expect(await attempt(ssr, "SELECT * FROM pub_wishlist_of('nobody')")).toBe('ok');
    expect(await attempt(worker, "SELECT * FROM pub_visit_log('nobody')")).toBe(DENIED);
  });
});

describe('sanity', () => {
  it('the CHECK code constant is the check_violation SQLSTATE', async () => {
    expect(await attempt(worker, "INSERT INTO job (kind) VALUES ('Not A Code')")).toBe(CHECK);
  });
});
