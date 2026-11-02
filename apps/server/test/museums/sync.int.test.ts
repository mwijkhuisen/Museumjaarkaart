import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpResponse, http } from 'msw';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger, silentLogger } from '../../src/lib/log.ts';
import { DEFAULT_PLAN_CONFIG } from '../../src/museums/diff.ts';
import { haversineMetres, type LatLon } from '../../src/museums/geo.ts';
import { DEFAULT_MATCH_CONFIG } from '../../src/museums/match.ts';
import { normaliseName } from '../../src/museums/normalise.ts';
import { fetchRce, parseRce } from '../../src/museums/sources/rce.ts';
import { fetchWikidata, parseWikidata, wikidataQuery } from '../../src/museums/sources/wikidata.ts';
import { type Fetchers, type FetchResult, runSync, type SyncConfig } from '../../src/museums/sync.ts';
import { similarity } from '../../src/museums/trigram.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { week2 } from '../fixtures/museums/week2.ts';

// The sync on PostgreSQL 18 as mjk_worker (plan §2.4; criteria 3 and 4): the
// seed, an unchanged re-run that changes no row (ctid and xmin), one week of
// news where only the safe fields apply, the empty guard, the dry run, the
// lock, and a source that cannot be fetched.

const FIXTURES = fileURLToPath(new URL('../fixtures/museums/', import.meta.url));
const read = (source: 'wikidata' | 'rce', name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${source}/${name}.json`, 'utf8'));

type SparqlAnswer = Parameters<typeof week2>[0];
const ENTITY = 'http://www.wikidata.org/entity/';
const normalWikidata = read('wikidata', 'normal') as SparqlAnswer;
const normalRce = read('rce', 'normal') as { features: unknown[] };

// Counts come from the parsed fixtures, so the test still holds after the owner re-records them (O1).
const parsedW = parseWikidata(normalWikidata);
const parsedR = parseRce(normalRce);
if (!parsedW.ok || !parsedR.ok) throw new Error('the normal fixtures must parse');
const W_ROWS = parsedW.rows.length;
const R_ROWS = parsedR.rows.length;
const MUSEUMS = parsedW.rows.filter((r) => r.dissolvedOn === null).length;

const ok = (body: unknown): FetchResult => ({ ok: true, body, ms: 7 });
const serve = (wikidata: unknown, rce: unknown): Fetchers => ({
  wikidata: async () => ok(wikidata),
  rce: async () => ok(rce),
});
const normal = () => serve(normalWikidata, normalRce);

/** The fixtures are small: the first-run floors of a real run would refuse them. */
const CFG: SyncConfig = {
  floors: { wikidata: 10, rce: 10 },
  minShare: 0.9,
  maxInvalidShare: 0.02,
  plan: DEFAULT_PLAN_CONFIG,
};

const TABLES = ['museum', 'museum_alias', 'museum_source_row', 'museum_change', 'municipality'] as const;

let test: TestDb;
let db: Db;
let client: pg.Client;

const q = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  (await client.query<T>(text, values)).rows;
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n);

/** Every row's physical identity and version: an UPDATE, even to the same values, changes them. */
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) {
    out[t] = (await q<{ v: string }>(`SELECT ctid::text || ':' || xmin::text AS v FROM ${t} ORDER BY 1`)).map(
      (r) => r.v,
    );
  }
  return out;
}

const museumOf = async (qid: string) =>
  (
    await q<{ id: string; name: string; lat: number; website: string | null }>(
      'SELECT id, name, lat, website FROM museum WHERE wikidata_qid = $1',
      [qid],
    )
  )[0];
const changesOf = async (museumId: string) =>
  q<{ field: string; state: string; new: unknown }>(
    'SELECT field, state, new FROM museum_change WHERE museum_id = $1 ORDER BY field, state',
    [museumId],
  );

async function freshDb() {
  await client?.end();
  await db?.destroy();
  if (test) await test.drop();
  test = await createMigratedDb();
  const pool = createPool('mjk_worker', { DATABASE_URL: test.urls.mjk_worker }, { max: 3 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
  client = new pg.Client({ connectionString: test.urls.mjk_worker });
  await client.connect();
}

beforeAll(freshDb);
afterAll(async () => {
  await client.end();
  await db.destroy();
  await test.drop();
});

describe('the seed and an unchanged re-run', () => {
  beforeAll(freshDb);

  it('a sync before the seed is refused (not_seeded) and changes nothing', async () => {
    const r = await runSync(db, normal(), silentLogger, { mode: 'sync' }, CFG);
    expect(r).toMatchObject({ outcome: 'refused', code: 'not_seeded' });
    expect(await count('museum')).toBe(0);
  });

  it('a seed dry run reports what it would create and writes nothing, not even a run row', async () => {
    const r = await runSync(db, normal(), silentLogger, { mode: 'seed', dryRun: true }, CFG);
    expect(r.outcome).toBe('dry_run');
    expect(r.summary.counts?.created).toBe(MUSEUMS);
    expect(await count('museum')).toBe(0);
    expect(await count('museum_source_row')).toBe(0);
    expect(await count('museum_sync_run')).toBe(1); // the not_seeded refusal above
  });

  it('the seed creates every museum and matches RCE as the fixture intends', async () => {
    const r = await runSync(db, normal(), silentLogger, { mode: 'seed' }, CFG);
    expect(r).toMatchObject({ outcome: 'applied', code: null });
    expect(await count('museum')).toBe(MUSEUMS);
    expect(await count('museum_source_row')).toBe(W_ROWS + R_ROWS);
    expect(await count('museum_change')).toBe(0);
    expect(r.summary.counts).toMatchObject({ created: MUSEUMS });

    // Every match the seed makes holds its own rule (A§7.3), checked from the stored rows: the same
    // postcode and a name similarity of at least 0.4, or under 150 m and at least 0.5. The real sample:
    // 38 of the 40 registered museums with coordinates find their RCE row.
    const rows = await q<{
      match_state: string;
      match_rule: string | null;
      payload: { name: string; postcode: string | null; lat: number | null; lon: number | null };
      name: string | null;
      postcode: string | null;
      lat: number | null;
      lon: number | null;
      aliases: string[] | null;
    }>(
      `SELECT s.match_state, s.match_rule, s.payload, m.name, m.postcode, m.lat, m.lon,
              (SELECT array_agg(a.alias) FROM museum_alias a WHERE a.museum_id = m.id) AS aliases
         FROM museum_source_row s LEFT JOIN museum m ON m.id = s.matched_museum_id WHERE s.source = 'rce'`,
    );
    const sim = (x: (typeof rows)[number]) =>
      Math.max(
        ...[x.name ?? '', ...(x.aliases ?? [])].map((n) => similarity(normaliseName(x.payload.name), normaliseName(n))),
      );
    for (const x of rows.filter((y) => y.match_state === 'matched')) {
      if (x.match_rule === 'postcode_name') {
        expect(x.payload.postcode).toBe(x.postcode);
        expect(sim(x)).toBeGreaterThanOrEqual(Math.fround(DEFAULT_MATCH_CONFIG.postcodeSimilarity));
      } else {
        expect(x.match_rule).toBe('distance_name');
        const d = haversineMetres(x.payload as LatLon, { lat: x.lat as number, lon: x.lon as number });
        expect(d).toBeLessThan(DEFAULT_MATCH_CONFIG.distanceMetres);
        expect(sim(x)).toBeGreaterThanOrEqual(Math.fround(DEFAULT_MATCH_CONFIG.distanceSimilarity));
      }
    }
    // Rows that match nothing wait as new; a seed sample this small has no RCE row with two candidates.
    expect(new Set(rows.map((x) => x.match_state))).toEqual(new Set(['matched', 'new']));
    const registeredWithCoords = parsedW.rows.filter((x) => x.registered && x.lat !== null).length;
    expect(rows.filter((x) => x.match_state === 'matched').length).toBeGreaterThanOrEqual(
      Math.floor(registeredWithCoords * 0.8),
    );
    // A matched RCE row gives its museum the rce_id and the RCE address.
    const matched = rows.filter((x) => x.match_state === 'matched').length;
    expect(matched).toBe(
      (r.summary.counts?.matched.postcode_name ?? 0) + (r.summary.counts?.matched.distance_name ?? 0),
    );
    const linked = await q<{ n: string }>(
      `SELECT count(*) AS n FROM museum m JOIN museum_source_row s ON s.matched_museum_id = m.id AND s.source = 'rce'
        WHERE m.rce_id = s.external_id AND m.street IS NOT DISTINCT FROM s.payload->>'street'`,
    );
    expect(Number(linked[0]?.n)).toBe(matched);
    expect(matched).toBeGreaterThan(0);
    // Every museum starts as unknown for the Museumkaart: nothing in P1a infers the flag.
    expect(await q('SELECT DISTINCT museumkaart_status FROM museum')).toEqual([{ museumkaart_status: 'unknown' }]);
  });

  it('a second seed is refused (already_seeded)', async () => {
    expect(await runSync(db, normal(), silentLogger, { mode: 'seed' }, CFG)).toMatchObject({
      outcome: 'refused',
      code: 'already_seeded',
    });
  });

  it('re-running a sync on the same input changes no row; only one run row is added (criterion 3)', async () => {
    const before = await snapshot();
    const runs = await count('museum_sync_run');
    const r = await runSync(db, normal(), silentLogger, { mode: 'sync' }, CFG);
    expect(r.outcome).toBe('applied');
    expect(r.summary.counts).toMatchObject({ applied: {}, pending: {}, superseded: 0, unchanged: W_ROWS + R_ROWS });
    expect(await snapshot()).toEqual(before);
    expect(await count('museum_sync_run')).toBe(runs + 1);
  });
});

describe('one week of news (week2)', () => {
  const { answer, picks } = week2(normalWikidata);

  beforeAll(async () => {
    await freshDb();
    expect((await runSync(db, normal(), silentLogger, { mode: 'seed' }, CFG)).outcome).toBe('applied');
  });

  it('applies only the safe fields; the rest waits in the queue (criteria 3 and 4)', async () => {
    const museumsBefore = await count('museum');
    const moved300Before = await museumOf(picks.moved300);
    const renamedBefore = await museumOf(picks.renamed);
    const r = await runSync(db, serve(answer, normalRce), silentLogger, { mode: 'sync' }, CFG);
    expect(r.outcome).toBe('applied');

    // A 100 m move and a new website apply, each with an applied change row.
    const m100 = await museumOf(picks.moved100);
    expect(await changesOf(m100?.id as string)).toEqual([
      expect.objectContaining({ field: 'coordinates', state: 'applied' }),
    ]);
    const web = await museumOf(picks.newWebsite);
    expect(web?.website).toBe('https://www.nieuwe-site.example/');
    expect(await changesOf(web?.id as string)).toEqual([
      expect.objectContaining({ field: 'website', state: 'applied' }),
    ]);

    // A 300 m move and a name change wait; the museum keeps its values.
    const m300 = await museumOf(picks.moved300);
    expect(m300?.lat).toBe(moved300Before?.lat);
    expect(await changesOf(m300?.id as string)).toEqual([
      expect.objectContaining({ field: 'coordinates', state: 'pending' }),
    ]);
    const renamed = await museumOf(picks.renamed);
    expect(renamed?.name).toBe(renamedBefore?.name);
    expect(await changesOf(renamed?.id as string)).toEqual([
      expect.objectContaining({ field: 'name', state: 'pending', new: `${renamedBefore?.name} Nieuw` }),
    ]);

    // A new P18 and a P576 closure wait.
    const img = await museumOf(picks.newImage);
    expect(await changesOf(img?.id as string)).toEqual([
      expect.objectContaining({ field: 'commons_file', state: 'pending', new: 'Nieuwe gevel 2026.jpg' }),
    ]);
    const closed = await museumOf(picks.dissolved);
    expect(await changesOf(closed?.id as string)).toEqual([
      expect.objectContaining({ field: 'closed_on', state: 'pending', new: '2026-10-01' }),
    ]);

    // Gone from Wikidata: queued, never deleted. The merge: the old QID is gone, the new one waits as qid_conflict.
    const gone = await museumOf(picks.gone);
    expect(gone).toBeDefined();
    expect(await changesOf(gone?.id as string)).toEqual([
      expect.objectContaining({ field: 'presence', state: 'pending' }),
    ]);
    const merged = await museumOf(picks.mergedFrom);
    expect(await changesOf(merged?.id as string)).toEqual([
      expect.objectContaining({ field: 'presence', state: 'pending' }),
    ]);
    expect(
      await q('SELECT match_state, match_reason, candidate_ids FROM museum_source_row WHERE external_id = $1', [
        picks.mergedInto,
      ]),
    ).toEqual([{ match_state: 'ambiguous', match_reason: 'qid_conflict', candidate_ids: [merged?.id] }]);
    expect(
      (
        await q<{ gone_since_run_id: string | null }>(
          'SELECT gone_since_run_id FROM museum_source_row WHERE external_id = $1',
          [picks.gone],
        )
      )[0]?.gone_since_run_id,
    ).not.toBeNull();

    // A new QID waits as a new museum; nothing was created or deleted.
    expect(
      await q('SELECT match_state, match_reason FROM museum_source_row WHERE external_id = $1', [picks.added]),
    ).toEqual([{ match_state: 'new', match_reason: 'no_candidate' }]);
    expect(await count('museum')).toBe(museumsBefore);
    expect(r.summary.counts?.applied).toEqual({ coordinates: 1, website: 1 });
    expect(r.summary.counts?.pending).toEqual({ closed_on: 1, commons_file: 1, coordinates: 1, name: 1, presence: 2 });
  });

  it('the same week again changes no row', async () => {
    const before = await snapshot();
    const r = await runSync(db, serve(answer, normalRce), silentLogger, { mode: 'sync' }, CFG);
    expect(r.summary.counts).toMatchObject({ applied: {}, pending: {}, superseded: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('the week before again supersedes the news it reverts, and changes nothing that was applied', async () => {
    const r = await runSync(db, normal(), silentLogger, { mode: 'sync' }, CFG);
    expect(r.outcome).toBe('applied');
    const pending = await q<{ field: string }>(
      "SELECT field FROM museum_change WHERE state = 'pending' ORDER BY field",
    );
    // Reverted: the 300 m move, the name, the image and the closure. Applied news is a new value, so it
    // comes back as a safe change (the 100 m move back, the old website).
    expect(pending).toEqual([]);
    expect(r.summary.counts?.applied).toEqual({ coordinates: 1, website: 1 });
    expect(r.summary.counts?.returned).toBe(2);
  });
});

describe('the empty guard (criterion 4)', () => {
  beforeAll(async () => {
    await freshDb();
    expect((await runSync(db, normal(), silentLogger, { mode: 'seed' }, CFG)).outcome).toBe('applied');
  });

  // Each case trips only the rule it names. The drop cases keep valid items only, so a recorded item
  // the parser rejects (the real `normal` has one without an nl or en label) cannot push the invalid
  // share over 2 % on its own; the invalid case adds label-less items and keeps every valid one.
  const valid = new Set(parsedW.rows.map((x) => x.qid));
  const validBindings = normalWikidata.results.bindings.filter((b) =>
    valid.has((b.item?.value ?? '').slice(ENTITY.length)),
  );
  const shrink = (share: number): SparqlAnswer => ({
    ...normalWikidata,
    results: { bindings: validBindings.slice(0, Math.floor(validBindings.length * share)) },
  });
  const labelless = Math.ceil(0.05 * W_ROWS) + 1;
  const withInvalid = (): SparqlAnswer => ({
    ...normalWikidata,
    results: {
      bindings: [
        ...normalWikidata.results.bindings,
        ...Array.from({ length: labelless }, (_, i) => ({
          item: { type: 'uri', value: `${ENTITY}Q9900${String(i).padStart(3, '0')}` },
          classes: { type: 'literal', value: `${ENTITY}Q33506` },
        })),
      ],
    },
  });

  it.each([
    ['under 90 % of the last run', () => serve(shrink(0.8), normalRce)],
    ['an empty answer', () => serve(read('wikidata', 'empty'), normalRce)],
    ['a schema failure', () => serve({ nope: true }, normalRce)],
    ['RCE under 90 %', () => serve(normalWikidata, { ...normalRce, features: normalRce.features.slice(0, 20) })],
    ['more than 2 % invalid rows', () => serve(withInvalid(), normalRce)],
  ])('%s applies nothing and keeps its baseline', async (_, fetchers) => {
    const before = await snapshot();
    const runs = await count('museum_sync_run');
    const r = await runSync(db, fetchers(), silentLogger, { mode: 'sync' }, CFG);
    expect(r).toMatchObject({ outcome: 'refused', code: 'empty_guard' });
    expect(await snapshot()).toEqual(before);
    expect(await count('museum_sync_run')).toBe(runs + 1);
    expect(
      await q("SELECT wikidata_rows, rce_rows FROM museum_sync_run WHERE outcome = 'applied' ORDER BY id DESC LIMIT 1"),
    ).toEqual([{ wikidata_rows: W_ROWS, rce_rows: R_ROWS }]);
  });

  it('--accept-drop applies one run below the guard for that source, and the baseline moves', async () => {
    const r = await runSync(
      db,
      serve(shrink(0.8), normalRce),
      silentLogger,
      { mode: 'sync', acceptDrop: 'wikidata' },
      CFG,
    );
    expect(r.outcome).toBe('applied');
    const kept = parseWikidata(shrink(0.8));
    if (!kept.ok) throw new Error('the shrunk fixture must parse');
    const keptQids = new Set(kept.rows.map((x) => x.qid));
    const dropped = parsedW.rows.filter((x) => !keptQids.has(x.qid) && x.dissolvedOn === null).length;
    expect(r.summary.counts?.pending).toEqual({ presence: dropped });
    expect(
      await q(
        "SELECT wikidata_rows, accept_drop FROM museum_sync_run WHERE outcome = 'applied' ORDER BY id DESC LIMIT 1",
      ),
    ).toEqual([{ wikidata_rows: kept.rows.length, accept_drop: 'wikidata' }]);
  });
});

describe('the run itself', () => {
  beforeAll(async () => {
    await freshDb();
    expect((await runSync(db, normal(), silentLogger, { mode: 'seed' }, CFG)).outcome).toBe('applied');
  });
  afterEach(() => server.resetHandlers());

  it('a dry run of a week of news writes nothing and reports the same counts', async () => {
    const { answer } = week2(normalWikidata);
    const before = await snapshot();
    const runs = await count('museum_sync_run');
    const r = await runSync(db, serve(answer, normalRce), silentLogger, { mode: 'sync', dryRun: true }, CFG);
    expect(r.outcome).toBe('dry_run');
    expect(r.summary.counts?.pending).toMatchObject({ name: 1, presence: 2 });
    expect(await snapshot()).toEqual(before);
    expect(await count('museum_sync_run')).toBe(runs);
  });

  it('a second run while one holds the lock exits sync_busy', async () => {
    const other = new pg.Client({ connectionString: test.urls.mjk_worker });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock(61000001)');
      expect(await runSync(db, normal(), silentLogger, { mode: 'sync' }, CFG)).toMatchObject({
        outcome: 'failed',
        code: 'sync_busy',
      });
    } finally {
      await other.end();
    }
  });

  it('a source that cannot be fetched fails the run with a fixed code and applies nothing', async () => {
    const before = await snapshot();
    const r = await runSync(
      db,
      { wikidata: async () => ({ ok: false, code: 'timeout' }), rce: async () => ok(normalRce) },
      silentLogger,
      { mode: 'sync' },
      CFG,
    );
    expect(r).toMatchObject({ outcome: 'failed', code: 'wikidata_unavailable' });
    expect(r.summary.sources.wikidata.status).toBe('timeout');
    expect(await snapshot()).toEqual(before);
  });

  it('through the real fetchers and msw: one request per source, with the User-Agent, then one log line', async () => {
    const agents: string[] = [];
    server.use(
      http.post('https://query.wikidata.org/sparql', ({ request }) => {
        agents.push(request.headers.get('user-agent') ?? '');
        return HttpResponse.json(normalWikidata);
      }),
      http.get('https://services.rce.geovoorziening.nl/*', ({ request }) => {
        agents.push(request.headers.get('user-agent') ?? '');
        return HttpResponse.json(normalRce);
      }),
    );
    const { logger, lines } = memoryLogger('worker');
    const fetchers: Fetchers = {
      wikidata: () => fetchWikidata(wikidataQuery(), {}),
      rce: () => fetchRce({}),
    };
    const r = await runSync(db, fetchers, logger, { mode: 'sync' }, CFG);
    expect(r.outcome).toBe('applied');
    expect(agents).toEqual([
      'mjk-museum-sync/1.0 (+https://github.com/mwijkhuisen/Museumjaarkaart)',
      'mjk-museum-sync/1.0 (+https://github.com/mwijkhuisen/Museumjaarkaart)',
    ]);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      msg: 'sync_applied',
      role: 'worker',
      mode: 'sync',
      wikidata_rows: W_ROWS,
      rce_rows: R_ROWS,
    });
  });
});
