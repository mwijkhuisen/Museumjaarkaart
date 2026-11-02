import { type RawBuilder, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { aliasBranch, ftsBranch, matches, nameBranch, setThreshold } from '../../src/museums/search.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { seedCatalogue } from '../seed-catalogue.ts';

// P1b criterion 6 (owner decision, 2026-11-02): the search queries are served by their indexes. EXPLAIN
// runs the very SQL the search module builds (its exported branch builders), as mjk_api, inside the
// transaction that sets the trigram threshold as production does, after the seed's ANALYZE, with the
// planner's defaults. The two trigram branches pick museum_name_trgm_idx and museum_alias_trgm_idx at
// the catalogue's own size of 1,400 museums (the COST of mjk_unaccent, migration 20261103000001). The
// full-text branch is another matter: at 1,400 rows a sequential scan costs ~0.7 ms against ~0.4 ms for
// the index, so for some words the planner is right to scan (and its estimate also depends on the GIN
// pending list that a fresh bulk load leaves unflushed). There the test proves that the index serves
// the query (with enable_seqscan off), then adds ~20,000 museums, flushes the pending list as autovacuum
// does (VACUUM, ANALYZE) and proves that the default planner picks museum_search_idx.

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] };

const nodesOf = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodesOf)];

let tdb: TestDb;
let api: Db;

beforeAll(async () => {
  tdb = await createMigratedDb();
  await seedCatalogue(tdb);
  const pool = createPool('mjk_api', { DATABASE_URL: tdb.urls.mjk_api }, { max: 2 });
  if (typeof pool === 'string') throw new Error(pool);
  api = createDb(pool);
}, 120_000);

afterAll(async () => {
  await api?.destroy();
  await tdb?.drop();
});

/** The plan nodes of `query` as the search runs it: read only, the threshold set, `settings` local. */
async function plan(query: RawBuilder<unknown>, settings: string[] = []): Promise<PlanNode[]> {
  return api
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await setThreshold(trx);
      for (const s of settings) await sql`${sql.raw(`SET LOCAL ${s}`)}`.execute(trx);
      const { rows } = await sql<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>`EXPLAIN (FORMAT JSON) ${query}`.execute(
        trx,
      );
      const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) throw new Error('no plan');
      return nodesOf(root);
    });
}

/** EXPLAIN (ANALYZE, BUFFERS) as text, for the pull request. */
async function text(query: RawBuilder<unknown>, label: string): Promise<void> {
  const lines = await api
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await setThreshold(trx);
      const { rows } = await sql<{ 'QUERY PLAN': string }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`.execute(
        trx,
      );
      return rows.map((r) => r['QUERY PLAN']);
    });
  console.info(`--- ${label}\n${lines.join('\n')}`);
}

const indexScans = (nodes: PlanNode[]) =>
  nodes
    .filter((n) => ['Bitmap Index Scan', 'Index Scan', 'Index Only Scan'].includes(n['Node Type']))
    .map((n) => `${n['Node Type']} on ${n['Index Name']}`);
const seqScans = (nodes: PlanNode[]) =>
  nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);

/** A typo (the trigram branches) and a word of a name (the full-text branch). */
const Q = 'rijksmusem';
const FTS_Q = 'rijksmuseum';

describe('at the size of the catalogue (1,400 museums, ANALYZE done by the seed)', () => {
  it('serves the name trigram branch from museum_name_trgm_idx with the default planner', async () => {
    const nodes = await plan(nameBranch(Q));
    expect(indexScans(nodes)).toContain('Bitmap Index Scan on museum_name_trgm_idx');
    expect(seqScans(nodes)).toEqual([]);
    await text(nameBranch(Q), 'name branch, 1,400 museums');
  });

  it('serves the alias trigram branch from museum_alias_trgm_idx with the default planner', async () => {
    const nodes = await plan(aliasBranch(Q));
    expect(indexScans(nodes)).toContain('Bitmap Index Scan on museum_alias_trgm_idx');
    expect(seqScans(nodes)).toEqual([]);
    await text(aliasBranch(Q), 'alias branch, 1,400 museums');
  });

  it('serves the full-text branch from museum_search_idx when a sequential scan is not allowed', async () => {
    // This proves the index serves the query (the `@@` form matches the GIN index). At 1,400 rows a
    // sequential scan is the right choice and the default planner takes it (printed below).
    const nodes = await plan(ftsBranch(FTS_Q), ['enable_seqscan = off']);
    expect(indexScans(nodes)).toContain('Bitmap Index Scan on museum_search_idx');
    expect(seqScans(nodes)).toEqual([]);
    await text(ftsBranch(FTS_Q), 'full-text branch, 1,400 museums (default planner)');
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
    const owner = createPool('mjk_migrator', { DATABASE_URL: tdb.urls.mjk_migrator }, { max: 1 });
    if (typeof owner === 'string') throw new Error(owner);
    const ownerDb = createDb(owner);
    try {
      // VACUUM flushes the GIN pending list of the 20,000 fresh inserts (fastupdate), which autovacuum
      // does in production: until then the planner prices museum_search_idx at ~1,300 and scans.
      await sql`VACUUM (ANALYZE) museum, museum_alias`.execute(ownerDb);
    } finally {
      await ownerDb.destroy();
    }
  }, 120_000);

  it('holds the synthetic museums and none of them contains the query word', async () => {
    const r = await sql<{ n: string; hits: string }>`
      SELECT count(*) AS n, count(*) FILTER (WHERE name ILIKE '%rijks%') AS hits FROM pub_museum`.execute(api);
    expect(Number(r.rows[0]?.n)).toBeGreaterThanOrEqual(21_000);
    expect(Number(r.rows[0]?.hits)).toBeLessThan(10);
  });

  it('serves the full-text branch from museum_search_idx with the default planner', async () => {
    const nodes = await plan(ftsBranch(FTS_Q));
    expect(indexScans(nodes)).toContain('Bitmap Index Scan on museum_search_idx');
    expect(seqScans(nodes)).toEqual([]);
    await text(ftsBranch(FTS_Q), 'full-text branch, ~21,400 museums');
  });

  it('keeps the two trigram branches on their indexes', async () => {
    expect(indexScans(await plan(nameBranch(Q)))).toContain('Bitmap Index Scan on museum_name_trgm_idx');
    expect(indexScans(await plan(aliasBranch(Q)))).toContain('Bitmap Index Scan on museum_alias_trgm_idx');
  });

  it('serves the whole search (three branches, one row per museum) from the three indexes', async () => {
    const nodes = await plan(matches(FTS_Q));
    const scans = indexScans(nodes);
    expect(scans).toContain('Bitmap Index Scan on museum_search_idx');
    expect(scans).toContain('Bitmap Index Scan on museum_name_trgm_idx');
    expect(scans).toContain('Bitmap Index Scan on museum_alias_trgm_idx');
    expect(seqScans(nodes)).toEqual([]);
  });
});
