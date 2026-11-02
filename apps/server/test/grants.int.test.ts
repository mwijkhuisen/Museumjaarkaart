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
const ALL = [...TABLES, VIEW];
// P1b's public views: the only objects mjk_ssr may read (A§8).
const PUB_VIEWS = ['pub_museum', 'pub_museum_alias', 'pub_slug_redirect', 'pub_province', 'pub_mk_list'] as const;
const PUB_SELECT = Object.fromEntries(PUB_VIEWS.map((v) => [v, ['SELECT']]));
const LOGINS = ['mjk_api', 'mjk_worker', 'mjk_ssr', 'mjk_backup'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const DENIED = '42501';
const CHECK = '23514';

/** The table-level privileges each login holds (the rest are column grants, tested below). */
const TABLE_LEVEL: Record<(typeof LOGINS)[number], Record<string, readonly string[]>> = {
  mjk_worker: {
    ...Object.fromEntries(ALL.map((t) => [t, ['SELECT']])),
    municipality: ['SELECT', 'INSERT', 'UPDATE'],
    museum_source_row: ['SELECT', 'INSERT', 'UPDATE'],
    museum_sync_run: ['SELECT', 'INSERT', 'UPDATE'],
    job: ['SELECT', 'INSERT', 'UPDATE'],
    museum_alias: ['SELECT', 'INSERT'],
  },
  mjk_api: {
    ...Object.fromEntries(ALL.map((t) => [t, ['SELECT']])),
    ...PUB_SELECT,
    museum_alias: ['SELECT', 'INSERT'],
    museum_slug_redirect: ['SELECT', 'INSERT'],
    museum_change: ['SELECT', 'INSERT'],
    mk_list_version: ['SELECT', 'INSERT'],
    mk_list_member: ['SELECT', 'INSERT'],
    job: ['SELECT', 'INSERT'],
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
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('the catalog', () => {
  it('table-level privileges match the matrix, and nobody holds DELETE, TRUNCATE, REFERENCES or TRIGGER', async () => {
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
      for (const table of TABLES) {
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
        decided_by: '0197f0a2-0000-7000-8000-000000000001',
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
          '0197f0a2-0000-7000-8000-000000000001',
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

describe('no login can DELETE or TRUNCATE', () => {
  it.each(LOGINS)('%s gets 42501 for DELETE and TRUNCATE on every P1a table', async (login) => {
    const c = { mjk_api: api, mjk_worker: worker, mjk_ssr: ssr, mjk_backup: backup }[login];
    for (const t of TABLES) {
      expect(await attempt(c, `DELETE FROM ${t}`), `${login} DELETE ${t}`).toBe(DENIED);
      expect(await attempt(c, `TRUNCATE ${t}`), `${login} TRUNCATE ${t}`).toBe(DENIED);
    }
  });
});

describe('sanity', () => {
  it('the CHECK code constant is the check_violation SQLSTATE', async () => {
    expect(await attempt(worker, "INSERT INTO job (kind) VALUES ('Not A Code')")).toBe(CHECK);
  });
});
