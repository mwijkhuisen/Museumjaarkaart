import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// The P1a schema (db/migrations/20261102*): every CHECK rejects a bad value and
// accepts a good one, the trigger, the view, the seed and the defaults. Values are
// always bound parameters; rows are written as mjk_api or mjk_worker, never the superuser.

let db: TestDb;
let api: pg.Client;
let worker: pg.Client;
const clients: pg.Client[] = [];
let n = 0;

const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};

/** Runs one statement in a transaction that is always rolled back: 'ok' or the SQLSTATE. */
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

/** An INSERT into `table` of the given columns, all values bound. Column names come from the test only. */
function insertSql(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    params: Object.values(row),
  };
}

const museumRow = (extra: Record<string, unknown> = {}) => ({ slug: `m-${n++}`, name: 'Museum', ...extra });
const tryMuseum = (extra: Record<string, unknown>, c = api) => {
  const { sql, params } = insertSql('museum', museumRow(extra));
  return attempt(c, sql, params);
};

const CHECK = '23514';

beforeAll(async () => {
  db = await createMigratedDb();
  api = await connect(db.urls.mjk_api);
  worker = await connect(db.urls.mjk_worker);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('museum CHECKs', () => {
  // [column(s), good value(s), bad values]: a bad value is a CHECK violation, a good one inserts.
  const single: [string, unknown[], unknown[]][] = [
    ['slug', ['rijksmuseum', 'a-b-2', 'x'.repeat(120)], ['Rijks', 'a_b', '-a', 'a-', 'a--b', '', 'x'.repeat(121)]],
    ['wikidata_qid', ['Q42', 'Q1234567'], ['q42', 'Q0', 'Q01', '42', 'Q4 2', '']],
    ['rce_id', ['abc-1.2:3_X', 'x'.repeat(64)], ['a b', 'x'.repeat(65), '', 'a/b']],
    ['name', ['M', 'x'.repeat(250)], ['', 'x'.repeat(251)]],
    ['name_en', ['M', 'x'.repeat(250)], ['', 'x'.repeat(251)]],
    ['description_nl', ['M', 'x'.repeat(250)], ['', 'x'.repeat(251)]],
    ['description_en', ['M', 'x'.repeat(250)], ['', 'x'.repeat(251)]],
    [
      'website',
      ['https://example.org/a?b=1'],
      ['http://example.org', 'ftp://example.org', 'https://a b', 'https://x/\n', `https://${'a'.repeat(2041)}`],
    ],
    ['street', ['x'.repeat(200)], ['', 'x'.repeat(201)]],
    ['house_number', ['12a', 'x'.repeat(20)], ['', 'x'.repeat(21)]],
    ['postcode', ['1234 AB', '9999 ZZ'], ['0123 AB', '1234AB', '1234 ab', '12345 AB', '1234 ABC']],
    ['place', ['x'.repeat(100)], ['', 'x'.repeat(101)]],
    [
      'museumnl_url',
      ['https://www.museum.nl/nl/museum/x'],
      [
        'http://www.museum.nl/x',
        'https://museum.nl/x',
        'https://www.museumXnl/x',
        'https://evil.example/https://www.museum.nl/',
        'https://www.museum.nl/a b',
      ],
    ],
    ['categories', [['art', 'other'], [], ['natural_history']], [['art', 'paintings'], ['Art']]],
    ['admission_adult_cents', [0, 20000], [-1, 20001]],
    ['photo_policy', ['allowed', 'no_flash', 'forbidden', 'unknown'], ['sometimes', '']],
    [
      'commons_file',
      ['Rijksmuseum Amsterdam.jpg', 'x'.repeat(255)],
      ['', 'x'.repeat(256), 'a/b.jpg', 'a#b', 'a<b', 'a>b', 'a[b', 'a]b', 'a|b', 'a{b', 'a}b', 'a\u0007b', 'a\tb'],
    ],
    [
      'pinned_fields',
      [['name', 'lat', 'categories'], []],
      [['museumkaart_status'], ['hidden'], ['name', 'photo_policy'], ['id']],
    ],
  ];
  it.each(single)('%s', async (column, good, bad) => {
    for (const v of good) expect(await tryMuseum({ [column]: v }), `${column} = ${JSON.stringify(v)}`).toBe('ok');
    for (const v of bad) expect(await tryMuseum({ [column]: v }), `${column} = ${JSON.stringify(v)}`).toBe(CHECK);
  });

  it('museumkaart_status takes the three statuses; left needs mk_until', async () => {
    expect(await tryMuseum({ museumkaart_status: 'participating' })).toBe('ok');
    expect(await tryMuseum({ museumkaart_status: 'unknown' })).toBe('ok');
    expect(await tryMuseum({ museumkaart_status: 'maybe' })).toBe(CHECK);
    expect(await tryMuseum({ museumkaart_status: 'left' })).toBe(CHECK);
    expect(await tryMuseum({ museumkaart_status: 'left', mk_until: '2026-01-01' })).toBe('ok');
  });

  it('mk_until may not precede mk_since', async () => {
    expect(await tryMuseum({ mk_since: '2026-02-01', mk_until: '2026-01-31' })).toBe(CHECK);
    expect(await tryMuseum({ mk_since: '2026-02-01', mk_until: '2026-02-01' })).toBe('ok');
    expect(await tryMuseum({ mk_since: '2026-02-01' })).toBe('ok');
    expect(await tryMuseum({ mk_until: '2026-02-01' })).toBe('ok');
  });

  it('lat and lon are both set or both null, inside the NL box (edges included)', async () => {
    expect(await tryMuseum({ lat: 52.1 })).toBe(CHECK);
    expect(await tryMuseum({ lon: 5.1 })).toBe(CHECK);
    expect(await tryMuseum({ lat: 52.1, lon: 5.1 })).toBe('ok');
    expect(await tryMuseum({})).toBe('ok');
    for (const [lat, lon] of [
      [50.7, 3.2],
      [53.7, 7.3],
      [50.7, 7.3],
      [53.7, 3.2],
    ])
      expect(await tryMuseum({ lat, lon }), `${lat},${lon}`).toBe('ok');
    for (const [lat, lon] of [
      [50.69, 5],
      [53.71, 5],
      [52, 3.19],
      [52, 7.31],
      [12.1, -68.3], // Bonaire: out of v1
      [0, 0],
    ])
      expect(await tryMuseum({ lat, lon }), `${lat},${lon}`).toBe(CHECK);
  });

  it('temp_closed_until needs temp_closed', async () => {
    expect(await tryMuseum({ temp_closed_until: '2027-01-01' })).toBe(CHECK);
    expect(await tryMuseum({ temp_closed: true, temp_closed_until: '2027-01-01' })).toBe('ok');
    expect(await tryMuseum({ temp_closed: true })).toBe('ok');
  });

  it('a municipality code must exist', async () => {
    expect(await tryMuseum({ municipality_code: 'GM9999' })).toBe('23503');
  });

  it('slug, wikidata_qid and rce_id are unique', async () => {
    const row = museumRow({ wikidata_qid: 'Q1', rce_id: 'r1' });
    const { sql, params } = insertSql('museum', row);
    await api.query(sql, params);
    const dup = (extra: Record<string, unknown>) => {
      const r = insertSql('museum', museumRow(extra));
      return attempt(api, r.sql, r.params);
    };
    expect(await dup({ wikidata_qid: 'Q1' })).toBe('23505');
    expect(await dup({ rce_id: 'r1' })).toBe('23505');
    expect(await dup({ slug: row.slug })).toBe('23505');
    expect(await dup({ wikidata_qid: 'Q2', rce_id: 'r2' })).toBe('ok');
  });
});

describe('reference data and other tables', () => {
  it('seeds the 12 provinces', async () => {
    const { rows } = await api.query<{ code: string; name_nl: string; name_en: string }>(
      'SELECT code, name_nl, name_en FROM province ORDER BY code',
    );
    expect(rows.map((r) => r.code)).toEqual([
      'NL-DR',
      'NL-FL',
      'NL-FR',
      'NL-GE',
      'NL-GR',
      'NL-LI',
      'NL-NB',
      'NL-NH',
      'NL-OV',
      'NL-UT',
      'NL-ZE',
      'NL-ZH',
    ]);
    expect(rows.find((r) => r.code === 'NL-FR')).toEqual({ code: 'NL-FR', name_nl: 'Fryslân', name_en: 'Friesland' });
    expect(rows.find((r) => r.code === 'NL-NB')?.name_en).toBe('North Brabant');
  });

  it('municipality: code form, name length, province must exist, province may be null', async () => {
    const m = (row: Record<string, unknown>) => {
      const r = insertSql('municipality', row);
      return attempt(worker, r.sql, r.params);
    };
    expect(await m({ cbs_code: 'GM0363', name: 'Amsterdam', province_code: 'NL-NH' })).toBe('ok');
    expect(await m({ cbs_code: 'GM0363', name: 'Amsterdam' })).toBe('ok');
    expect(await m({ cbs_code: 'GM363', name: 'Amsterdam' })).toBe(CHECK);
    expect(await m({ cbs_code: 'gm0363', name: 'Amsterdam' })).toBe(CHECK);
    expect(await m({ cbs_code: 'GM0363', name: '' })).toBe(CHECK);
    expect(await m({ cbs_code: 'GM0363', name: 'x'.repeat(101) })).toBe(CHECK);
    expect(await m({ cbs_code: 'GM0363', name: 'Amsterdam', province_code: 'NL-XX' })).toBe('23503');
  });

  it('museum_alias: source list, unique per museum, length', async () => {
    const { rows } = await api.query<{ id: string }>(`${insertSql('museum', museumRow()).sql} RETURNING id`, [
      `m-${n++}`,
      'Museum',
    ]);
    const id = rows[0]?.id;
    const a = (row: Record<string, unknown>) => {
      const r = insertSql('museum_alias', { museum_id: id, ...row });
      return attempt(api, r.sql, r.params);
    };
    expect(await a({ alias: 'Oud', source: 'wikidata' })).toBe('ok');
    expect(await a({ alias: 'Oud', source: 'import' })).toBe('ok');
    expect(await a({ alias: 'Oud', source: 'admin' })).toBe('ok');
    expect(await a({ alias: 'Oud', source: 'web' })).toBe(CHECK);
    expect(await a({ alias: '', source: 'admin' })).toBe(CHECK);
    expect(await a({ alias: 'x'.repeat(251), source: 'admin' })).toBe(CHECK);
    await api.query('INSERT INTO museum_alias (museum_id, alias, source) VALUES ($1, $2, $3)', [id, 'Dup', 'admin']);
    expect(await a({ alias: 'Dup', source: 'admin' })).toBe('23505');
  });

  it('museum_sync_run: mode, outcome, code, accept_drop and row counts', async () => {
    const r = (row: Record<string, unknown>) => {
      const q = insertSql('museum_sync_run', row);
      return attempt(worker, q.sql, q.params);
    };
    expect(await r({ mode: 'seed' })).toBe('ok');
    expect(
      await r({ mode: 'sync', outcome: 'refused', code: 'not_seeded', accept_drop: 'rce', wikidata_rows: 0 }),
    ).toBe('ok');
    expect(await r({ mode: 'daily' })).toBe(CHECK);
    expect(await r({ mode: 'sync', outcome: 'done' })).toBe(CHECK);
    expect(await r({ mode: 'sync', code: 'Not seeded: details' })).toBe(CHECK);
    expect(await r({ mode: 'sync', code: 'x'.repeat(41) })).toBe(CHECK);
    expect(await r({ mode: 'sync', accept_drop: 'osm' })).toBe(CHECK);
    expect(await r({ mode: 'sync', wikidata_rows: -1 })).toBe(CHECK);
    expect(await r({ mode: 'sync', rce_rows: -1 })).toBe(CHECK);
  });

  describe('museum_source_row and museum_change', () => {
    let runId: string;
    let museumId: string;
    const hash = 'a'.repeat(64);
    const sourceRow = (extra: Record<string, unknown>) => ({
      source: 'wikidata',
      external_id: 'Q1',
      payload: '{}',
      hash,
      run_id: runId,
      match_state: 'new',
      ...extra,
    });

    beforeAll(async () => {
      const run = await worker.query<{ id: string }>("INSERT INTO museum_sync_run (mode) VALUES ('seed') RETURNING id");
      runId = run.rows[0]?.id as string;
      museumId = (
        await api.query<{ id: string }>(`${insertSql('museum', museumRow()).sql} RETURNING id`, [`m-${n++}`, 'Museum'])
      ).rows[0]?.id as string;
    });

    it('museum_source_row CHECKs', async () => {
      const s = (extra: Record<string, unknown>) => {
        const q = insertSql('museum_source_row', sourceRow(extra));
        return attempt(worker, q.sql, q.params);
      };
      expect(await s({})).toBe('ok');
      expect(await s({ source: 'rce', external_id: 'x'.repeat(64) })).toBe('ok');
      expect(await s({ source: 'museumnl' })).toBe(CHECK);
      expect(await s({ external_id: '' })).toBe(CHECK);
      expect(await s({ external_id: 'x'.repeat(65) })).toBe(CHECK);
      expect(await s({ hash: 'A'.repeat(64) })).toBe(CHECK);
      expect(await s({ hash: 'a'.repeat(63) })).toBe(CHECK);
      expect(await s({ match_state: 'maybe' })).toBe(CHECK);
      expect(await s({ match_state: 'ambiguous', match_reason: 'ambiguous', candidate_ids: [museumId] })).toBe('ok');
      expect(await s({ match_state: 'ignored', match_reason: 'dissolved' })).toBe('ok');
      expect(await s({ match_state: 'ignored', match_reason: 'other' })).toBe(CHECK);
      expect(await s({ match_state: 'matched', matched_museum_id: museumId, match_rule: 'distance_name' })).toBe('ok');
      expect(await s({ match_state: 'matched', matched_museum_id: museumId, match_rule: 'fuzzy' })).toBe(CHECK);
      // matched exactly when there is a museum
      expect(await s({ match_state: 'matched' })).toBe(CHECK);
      expect(await s({ match_state: 'new', matched_museum_id: museumId })).toBe(CHECK);
      expect(await s({ run_id: '999999' })).toBe('23503');
      expect(await s({ gone_since_run_id: '999999' })).toBe('23503');
    });

    it('museum_source_row is keyed by (source, external_id)', async () => {
      const q = insertSql('museum_source_row', sourceRow({ external_id: 'Q-dup' }));
      await worker.query(q.sql, q.params);
      expect(await attempt(worker, q.sql, q.params)).toBe('23505');
      const other = insertSql('museum_source_row', sourceRow({ source: 'rce', external_id: 'Q-dup' }));
      expect(await attempt(worker, other.sql, other.params)).toBe('ok');
    });

    it('museum_change CHECKs', async () => {
      const c = (extra: Record<string, unknown>, client = worker) => {
        const q = insertSql('museum_change', { museum_id: museumId, field: 'name', state: 'applied', ...extra });
        return attempt(client, q.sql, q.params);
      };
      expect(await c({})).toBe('ok');
      for (const field of ['new_museum', 'presence', 'qid_link', 'coordinates', 'museumkaart_status'])
        expect(await c({ field }), field).toBe('ok');
      expect(await c({ field: 'nickname' })).toBe(CHECK);
      expect(await c({ field: 'id' })).toBe(CHECK);
      expect(await c({ state: 'maybe' })).toBe(CHECK);
      for (const state of ['applied', 'pending', 'rejected', 'superseded'])
        expect(await c({ state }), state).toBe('ok');
      expect(await c({ source: 'osm' })).toBe(CHECK);
      expect(await c({ origin: 'admin' }, api)).toBe('ok');
      expect(await c({ origin: 'report' }, api)).toBe('ok');
      expect(await c({ origin: 'import' }, api)).toBe(CHECK);
      expect(await c({ old: JSON.stringify({ lat: 52, lon: 5 }), new: 'null' })).toBe('ok');
      // a pending change names its museum; others may not (a new museum has none yet)
      expect(await c({ museum_id: null, state: 'pending', field: 'new_museum' })).toBe(CHECK);
      expect(await c({ museum_id: null, state: 'applied', field: 'new_museum' })).toBe('ok');
      expect(await c({ run_id: '999999' })).toBe('23503');
    });

    it('museum_change links to its source row (MATCH SIMPLE)', async () => {
      const row = insertSql('museum_source_row', sourceRow({ external_id: 'Q-link' }));
      await worker.query(row.sql, row.params);
      const c = (extra: Record<string, unknown>) => {
        const q = insertSql('museum_change', { museum_id: museumId, field: 'name', state: 'applied', ...extra });
        return attempt(worker, q.sql, q.params);
      };
      expect(await c({ source: 'wikidata', external_id: 'Q-link' })).toBe('ok');
      expect(await c({ source: 'wikidata', external_id: 'Q-nope' })).toBe('23503');
      expect(await c({ source: 'wikidata' })).toBe('ok'); // MATCH SIMPLE: one null skips the check
      expect(await c({})).toBe('ok');
    });

    it('museum_change allows one pending change per museum, field and source', async () => {
      const q = (extra: Record<string, unknown>) =>
        insertSql('museum_change', { museum_id: museumId, field: 'website', state: 'pending', ...extra });
      const first = q({ source: 'wikidata' });
      await worker.query(first.sql, first.params);
      expect(await attempt(worker, first.sql, first.params)).toBe('23505');
      const other = q({ source: 'rce' });
      expect(await attempt(worker, other.sql, other.params)).toBe('ok');
      const sameButApplied = q({ source: 'wikidata', state: 'applied' });
      expect(await attempt(worker, sameButApplied.sql, sameButApplied.params)).toBe('ok');
      // a null source counts as one value (NULLS NOT DISTINCT)
      const noSource = q({});
      await worker.query(noSource.sql, noSource.params);
      expect(await attempt(worker, noSource.sql, noSource.params)).toBe('23505');
    });
  });
});

describe('trigger, view and defaults', () => {
  it('a museum UPDATE moves updated_at, and an INSERT sets both times alike', async () => {
    const { rows: ins } = await api.query<{ id: string; created_at: Date; updated_at: Date }>(
      `${insertSql('museum', museumRow()).sql} RETURNING id, created_at, updated_at`,
      [`m-${n++}`, 'Museum'],
    );
    const row = ins[0];
    expect(row?.updated_at.getTime()).toBe(row?.created_at.getTime());
    const { rows } = await api.query<{ created_at: Date; updated_at: Date }>(
      'UPDATE museum SET name = $1 WHERE id = $2 RETURNING created_at, updated_at',
      ['Nieuwe naam', row?.id],
    );
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(row?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
    expect(rows[0]?.created_at.getTime()).toBe(row?.created_at.getTime());
  });

  it('no login can write updated_at or created_at', async () => {
    const { rows } = await api.query<{ id: string }>(`${insertSql('museum', museumRow()).sql} RETURNING id`, [
      `m-${n++}`,
      'Museum',
    ]);
    for (const col of ['updated_at', 'created_at', 'id'])
      expect(
        await attempt(api, `UPDATE museum SET ${col} = $1 WHERE id = $2`, [
          col === 'id' ? rows[0]?.id : new Date(),
          rows[0]?.id,
        ]),
        col,
      ).toBe('42501');
  });

  it('the trigger function is plpgsql and pins its search_path', async () => {
    const { rows } = await api.query<{ lang: string; owner: string; config: string[]; secdef: boolean }>(
      `SELECT l.lanname AS lang, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.prosecdef AS secdef
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.proname = 'museum_set_updated_at'`,
    );
    expect(rows).toEqual([
      { lang: 'plpgsql', owner: 'mjk_migrator', config: ['search_path=pg_catalog, pg_temp'], secdef: false },
    ]);
  });

  it('mk_list has no row without a version, then counts the newest version', async () => {
    const view = () =>
      api.query<{ list_version_id: string; published_on: string; n: string }>(
        'SELECT list_version_id, published_on::text AS published_on, n FROM mk_list',
      );
    expect((await view()).rows).toEqual([]);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await api.query<{ id: string }>(`${insertSql('museum', museumRow()).sql} RETURNING id`, [
        `m-${n++}`,
        'Museum',
      ]);
      ids.push(r.rows[0]?.id as string);
    }
    const version = async (publishedOn: string, members: string[]) => {
      const r = await api.query<{ id: string }>('INSERT INTO mk_list_version (published_on) VALUES ($1) RETURNING id', [
        publishedOn,
      ]);
      const id = r.rows[0]?.id as string;
      for (const m of members)
        await api.query('INSERT INTO mk_list_member (list_version_id, museum_id) VALUES ($1, $2)', [id, m]);
      return id;
    };
    const old = await version('2026-01-01', ids.slice(0, 1));
    expect((await view()).rows).toEqual([{ list_version_id: old, published_on: '2026-01-01', n: '1' }]);
    const newest = await version('2027-01-01', ids);
    expect((await view()).rows).toEqual([{ list_version_id: newest, published_on: '2027-01-01', n: '3' }]);
    // a version with no members yet: the newest, n = 0
    const empty = await version('2028-01-01', []);
    expect((await view()).rows).toEqual([{ list_version_id: empty, published_on: '2028-01-01', n: '0' }]);

    expect(await attempt(api, 'INSERT INTO mk_list_version (published_on) VALUES ($1)', ['2027-01-01'])).toBe('23505');
    expect(
      await attempt(api, 'INSERT INTO mk_list_member (list_version_id, museum_id) VALUES ($1, $2)', [newest, ids[0]]),
    ).toBe('23505');
  });

  it('museum defaults', async () => {
    const { rows } = await api.query(`${insertSql('museum', museumRow()).sql} RETURNING *`, [`m-${n++}`, 'Museum']);
    expect(rows[0]).toMatchObject({
      categories: [],
      registered: false,
      museumkaart_status: 'unknown',
      photo_policy: 'unknown',
      temp_closed: false,
      temp_closed_until: null,
      hidden: false,
      pinned_fields: [],
      closed_on: null,
      admission_adult_cents: null,
      mk_since: null,
      mk_until: null,
      wikidata_qid: null,
      rce_id: null,
      lat: null,
      lon: null,
    });
    expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('defaults of museum_sync_run, museum_change and job', async () => {
    const run = await worker.query("INSERT INTO museum_sync_run (mode) VALUES ('sync') RETURNING *");
    expect(run.rows[0]).toMatchObject({ mode: 'sync', counts: {}, outcome: null, finished_at: null, code: null });
    expect(run.rows[0].started_at).toBeInstanceOf(Date);
    const ch = await worker.query(
      "INSERT INTO museum_change (field, state) VALUES ('new_museum', 'applied') RETURNING *",
    );
    expect(ch.rows[0]).toMatchObject({ origin: 'sync', museum_id: null, reporter_id: null, decided_by: null });
    const job = await worker.query("INSERT INTO job (kind) VALUES ('museum_sync') RETURNING *");
    expect(job.rows[0]).toMatchObject({
      kind: 'museum_sync',
      payload: {},
      state: 'queued',
      attempts: 0,
      max_attempts: 5,
      locked_at: null,
      locked_by: null,
      last_error: null,
      finished_at: null,
    });
    expect(job.rows[0].run_at).toBeInstanceOf(Date);
  });
});

describe('job CHECKs', () => {
  const j = (row: Record<string, unknown>) => {
    const q = insertSql('job', { kind: 'museum_sync', ...row });
    return attempt(worker, q.sql, q.params);
  };

  it('last_error is a fixed code, never a message', async () => {
    expect(await j({ last_error: 'internal' })).toBe('ok');
    expect(await j({ last_error: 'rate_limited' })).toBe('ok');
    expect(await j({ last_error: 'something went wrong' })).toBe(CHECK);
    expect(await j({ last_error: 'user@example.org' })).toBe(CHECK);
    expect(await j({ last_error: 'Internal' })).toBe(CHECK);
    expect(await j({ last_error: '' })).toBe(CHECK);
    expect(await j({ last_error: 'x'.repeat(41) })).toBe(CHECK);
  });

  it('kind, state, attempts, max_attempts and locked_by', async () => {
    expect(await j({ kind: 'Museum Sync' })).toBe(CHECK);
    expect(await j({ kind: '' })).toBe(CHECK);
    expect(await j({ kind: 'x'.repeat(41) })).toBe(CHECK);
    for (const state of ['queued', 'running', 'done', 'failed']) expect(await j({ state }), state).toBe('ok');
    expect(await j({ state: 'paused' })).toBe(CHECK);
    expect(await j({ attempts: -1 })).toBe(CHECK);
    expect(await j({ max_attempts: 0 })).toBe(CHECK);
    expect(await j({ max_attempts: 1 })).toBe('ok');
    expect(await j({ max_attempts: 20 })).toBe('ok');
    expect(await j({ max_attempts: 21 })).toBe(CHECK);
    expect(await j({ locked_by: 'x'.repeat(100) })).toBe('ok');
    expect(await j({ locked_by: 'x'.repeat(101) })).toBe(CHECK);
  });
});
