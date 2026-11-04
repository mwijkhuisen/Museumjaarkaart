import { Kysely, PostgresDialect, sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import type { DB } from '../../src/db/types.ts';
import { getMuseumDetail } from '../../src/museums/detail.ts';
import { findNearest } from '../../src/museums/near.ts';
import { listMuseums } from '../../src/museums/query.ts';
import { matches } from '../../src/museums/search.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// P1b criterion 6 (owner decision, 2026-11-02, amended with the definer search function): the search is
// served by its indexes. EXPLAIN runs exactly the body of public.pub_search (read from pg_proc.prosrc),
// prepared with a `text` parameter as its owner mjk_migrator (the definer), inside a transaction that sets
// the function's own search_path and trigram threshold (read from its proconfig), after the seed's
// ANALYZE, with the planner's defaults. The two trigram branches pick museum_name_trgm_idx and
// museum_alias_trgm_idx at the catalogue's own size of 1,400 museums (the COST of mjk_unaccent, migration
// 20261103000001). The full-text branch is another matter: at 1,400 rows a sequential scan costs ~0.7 ms
// against ~0.4 ms for the index, so for some words the planner is right to scan (and its estimate also
// depends on the GIN pending list that a fresh bulk load leaves unflushed). There the test proves that the
// index serves the query (with enable_seqscan off), then adds ~20,000 museums, flushes the pending list as
// autovacuum does (VACUUM, ANALYZE) and proves that the default planner picks museum_search_idx.
//
// A SQL function's plan may be cached and turn generic (no value for $1), so each size also checks the
// generic plan (plan_cache_mode = force_generic_plan). Finally the list, near-me and detail queries are
// explained through the security_barrier views as mjk_api, at 1,400 museums.

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] };

const nodesOf = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodesOf)];

let tdb: TestDb;
let cat: SeededCatalogue;
let api: Db;
let owner: Db;
/** pub_search's body and the settings it runs with (`name=value` from proconfig). */
let body: string;
let config: string[];

beforeAll(async () => {
  tdb = await createMigratedDb();
  cat = await seedCatalogue(tdb);
  const pool = createPool('mjk_api', { DATABASE_URL: tdb.urls.mjk_api }, { max: 2 });
  if (typeof pool === 'string') throw new Error(pool);
  api = createDb(pool);
  const ownerPool = createPool('mjk_migrator', { DATABASE_URL: tdb.urls.mjk_migrator }, { max: 1 });
  if (typeof ownerPool === 'string') throw new Error(ownerPool);
  owner = createDb(ownerPool);
  const fn = await sql<{ src: string; config: string[] }>`
    SELECT prosrc AS src, proconfig AS config FROM pg_proc WHERE oid = 'public.pub_search(text)'::regprocedure`.execute(
    owner,
  );
  body = fn.rows[0]?.src ?? '';
  config = fn.rows[0]?.config ?? [];
}, 120_000);

afterAll(async () => {
  await api?.destroy();
  await owner?.destroy();
  await tdb?.drop();
});

/** Runs `fn` as mjk_migrator in a read-only transaction with the function's settings, body prepared. */
async function withBody<T>(settings: string[], fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return owner
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      for (const c of config) {
        const at = c.indexOf('=');
        await sql`SELECT set_config(${c.slice(0, at)}, ${c.slice(at + 1)}, true)`.execute(trx);
      }
      for (const s of settings) await sql`${sql.raw(`SET LOCAL ${s}`)}`.execute(trx);
      // A prepared statement outlives its transaction: start clean on this owner-only connection.
      await sql`DEALLOCATE ALL`.execute(trx);
      await sql`${sql.raw(`PREPARE pub_search_body(text) AS ${body}`)}`.execute(trx);
      return fn(trx);
    });
}

/** The plan nodes of the body for `q`; `settings` are SET LOCAL. */
async function plan(q: string, settings: string[] = []): Promise<PlanNode[]> {
  return withBody(settings, async (trx) => {
    const { rows } = await sql<{
      'QUERY PLAN': Array<{ Plan: PlanNode }>;
    }>`EXPLAIN (FORMAT JSON) EXECUTE pub_search_body(${sql.lit(q)})`.execute(trx);
    const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
    if (root === undefined) throw new Error('no plan');
    return nodesOf(root);
  });
}

/** EXPLAIN (ANALYZE, BUFFERS) of the body as text, for the pull request. */
async function text(q: string, label: string, settings: string[] = []): Promise<void> {
  const lines = await withBody(settings, async (trx) => {
    const { rows } = await sql<{
      'QUERY PLAN': string;
    }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE pub_search_body(${sql.lit(q)})`.execute(trx);
    return rows.map((r) => r['QUERY PLAN']);
  });
  console.info(`--- ${label}\n${lines.join('\n')}`);
}

const GENERIC = ['plan_cache_mode = force_generic_plan'];

const indexScans = (nodes: PlanNode[]) =>
  nodes
    .filter((n) => ['Bitmap Index Scan', 'Index Scan', 'Index Only Scan'].includes(n['Node Type']))
    .map((n) => `${n['Node Type']} on ${n['Index Name']}`);
const seqScans = (nodes: PlanNode[]) =>
  nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);

const NAME_IDX = 'Bitmap Index Scan on museum_name_trgm_idx';
const ALIAS_IDX = 'Bitmap Index Scan on museum_alias_trgm_idx';
const FTS_IDX = 'Bitmap Index Scan on museum_search_idx';

/** A typo (only the trigram branches match) and a word of a name (the full-text branch). */
const Q = 'rijksmusem';
const FTS_Q = 'rijksmuseum';

describe('the explained SQL is the function', () => {
  it('reads a static body that uses $1 only, and the prepared body answers exactly what pub_search answers', async () => {
    expect(body).toContain('$1');
    expect(body).not.toMatch(/\bEXECUTE\b|format\(|\$2/i);
    expect(config).toEqual(['search_path=pg_catalog, pg_temp', 'pg_trgm.word_similarity_threshold=0.55']);
    for (const q of [Q, FTS_Q, 'kroller muller', 'communicatimuseum']) {
      const viaBody = await withBody(
        [],
        async (trx) =>
          (await sql<{ id: string; tier: number; score: number }>`EXECUTE pub_search_body(${sql.lit(q)})`.execute(trx))
            .rows,
      );
      const viaFunction = (await sql<{ id: string; tier: number; score: number }>`${matches(q)}`.execute(api)).rows;
      expect(viaFunction.length, q).toBeGreaterThan(0);
      expect(viaFunction, q).toEqual(viaBody);
    }
  });
});

describe('at the size of the catalogue (1,400 museums, ANALYZE done by the seed)', () => {
  it('serves both trigram branches from their GIN indexes with the default planner', async () => {
    const nodes = await plan(Q);
    expect(indexScans(nodes)).toContain(NAME_IDX);
    expect(indexScans(nodes)).toContain(ALIAS_IDX);
    await text(Q, `pub_search body, q=${Q}, 1,400 museums, custom plan`);
  });

  it('serves the full-text branch from museum_search_idx when a sequential scan is not allowed', async () => {
    // This proves the index serves the query (the `@@` form matches the GIN index). At 1,400 rows a
    // sequential scan is the right choice and the default planner takes it (printed below).
    const nodes = await plan(FTS_Q, ['enable_seqscan = off']);
    expect(indexScans(nodes)).toEqual(expect.arrayContaining([FTS_IDX, NAME_IDX, ALIAS_IDX]));
    expect(seqScans(nodes)).toEqual([]);
    await text(FTS_Q, `pub_search body, q=${FTS_Q}, 1,400 museums, custom plan (default planner)`);
  });

  it('a generic plan (no value for $1) keeps the trigram branches on their indexes', async () => {
    const nodes = await plan(Q, GENERIC);
    expect(indexScans(nodes)).toContain(NAME_IDX);
    expect(indexScans(nodes)).toContain(ALIAS_IDX);
    await text(Q, `pub_search body, q=${Q}, 1,400 museums, generic plan`, GENERIC);
  });
});

describe('through the barrier views as mjk_api (1,400 museums)', () => {
  /** Runs `run` on a Kysely as mjk_api that records each statement, then EXPLAINs the first that matches. */
  async function explainLast(label: string, run: (db: Db) => Promise<unknown>, match: RegExp): Promise<PlanNode[]> {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const pool = createPool('mjk_api', { DATABASE_URL: tdb.urls.mjk_api }, { max: 1 }) as pg.Pool;
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
      log: (e) => {
        if (e.level === 'query' && /\bpub_/.test(e.query.sql))
          seen.push({ sql: e.query.sql, params: e.query.parameters });
      },
    });
    try {
      await run(db);
      const q = seen.find((x) => match.test(x.sql));
      if (q === undefined) throw new Error('no statement');
      const json = await pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        `EXPLAIN (FORMAT JSON) ${q.sql}`,
        q.params as unknown[],
      );
      const textPlan = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`,
        q.params as unknown[],
      );
      console.info(`--- ${label}\n${textPlan.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
      const root = json.rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) throw new Error('no plan');
      return nodesOf(root);
    } finally {
      await db.destroy();
    }
  }

  it('the list keyset page: the keyset qual passes the barrier to museum_sort_idx', async () => {
    const first = await listMuseums(api, { limit: 20 });
    const cursor = first.next_cursor ?? undefined;
    expect(cursor).toBeDefined();
    // the page query, not the count that follows it
    const nodes = await explainLast(
      'list, second page (keyset), through pub_museum',
      (db) => listMuseums(db, { limit: 20, cursor }),
      /order by/i,
    );
    expect(indexScans(nodes).join(' ')).toContain('museum_sort_idx');
  });

  it('near-me: the box passes the barrier to museum_lat_lon_idx', async () => {
    const nodes = await explainLast(
      'near-me, 52.372 4.894 limit 20, through pub_museum',
      (db) => findNearest(db, { lat: 52.372, lon: 4.894, limit: 20 }),
      /pub_museum/,
    );
    expect(indexScans(nodes).join(' ')).toContain('museum_lat_lon_idx');
  });

  it('detail: the slug passes the barrier to the unique index on museum.slug', async () => {
    const nodes = await explainLast(
      'detail by slug, through pub_museum',
      (db) => getMuseumDetail(db, cat.named.kroller.slug),
      /"pub_museum"/,
    );
    expect(indexScans(nodes).join(' ')).toContain('museum_slug_key');
  });
});

describe('at ~21,400 museums', () => {
  beforeAll(async () => {
    // 20,000 synthetic museums as mjk_api (the trigger fills `search`); no name has a word of the query.
    await sql`
      INSERT INTO museum (slug, name, place)
      SELECT 'synthetisch-' || g,
             (ARRAY['Oud','Nieuw','Groot','Klein','Zuidelijk','Noordelijk','Oostelijk','Westelijk','Koninklijk','Stedelijk'])[1 + g % 10]
               || ' ' || (ARRAY['Depot','Archief','Atelier','Kabinet','Park','Huis','Hof','Fort','Werf','Molen','Poort','Toren'])[1 + (g / 10) % 12]
               || ' ' || (ARRAY['Kunst','Natuur','Techniek','Streek','Ambacht','Spoor','Water','Wind'])[1 + (g / 120) % 8]
               || ' nr ' || g,
             (ARRAY['Assen','Breda','Delft','Ede','Gouda','Haarlem','Leiden','Venlo'])[1 + g % 8]
      FROM generate_series(1, 20000) g`.execute(api);
    // VACUUM flushes the GIN pending list of the 20,000 fresh inserts (fastupdate), which autovacuum
    // does in production: until then the planner prices museum_search_idx at ~1,300 and scans.
    await sql`VACUUM (ANALYZE) museum, museum_alias`.execute(owner);
  }, 120_000);

  it('holds the synthetic museums and none of them contains the query word', async () => {
    const r = await sql<{ n: string; hits: string }>`
      SELECT count(*) AS n, count(*) FILTER (WHERE name ILIKE '%rijks%') AS hits FROM pub_museum`.execute(api);
    expect(Number(r.rows[0]?.n)).toBeGreaterThanOrEqual(21_000);
    expect(Number(r.rows[0]?.hits)).toBeLessThan(10);
  });

  it('serves the whole search (three branches, one row per museum) from the three indexes', async () => {
    const nodes = await plan(FTS_Q);
    expect(indexScans(nodes)).toEqual(expect.arrayContaining([FTS_IDX, NAME_IDX, ALIAS_IDX]));
    expect(seqScans(nodes)).toEqual([]);
    await text(FTS_Q, `pub_search body, q=${FTS_Q}, ~21,400 museums, custom plan`);
  });

  it('keeps the trigram branches on their indexes for a typo', async () => {
    const nodes = await plan(Q);
    expect(indexScans(nodes)).toEqual(expect.arrayContaining([NAME_IDX, ALIAS_IDX]));
  });

  it('a generic plan serves all three branches from their indexes too', async () => {
    const nodes = await plan(FTS_Q, GENERIC);
    expect(indexScans(nodes)).toEqual(expect.arrayContaining([FTS_IDX, NAME_IDX, ALIAS_IDX]));
    expect(seqScans(nodes)).toEqual([]);
    await text(FTS_Q, `pub_search body, q=${FTS_Q}, ~21,400 museums, generic plan`, GENERIC);
  });
});
