import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../src/db/kysely.ts';
import { createPool } from '../src/db/pool.ts';
import { EXIT_REFUSED, run } from '../src/main.ts';
import type { Fetchers } from '../src/museums/sync.ts';
import { enqueue } from '../src/worker/queue.ts';
import { createMigratedDb, type TestDb } from './db.ts';

// The role wiring (A§5): sync-museums, worker and admin dispatch through main.ts
// with the right login. Sources are injected; nothing reaches the network.

const FIXTURES = fileURLToPath(new URL('fixtures/museums/', import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${FIXTURES}${path}.json`, 'utf8'));
const fixtures = (wikidata: string, rce: string): Fetchers => ({
  wikidata: async () => ({ ok: true, body: read(wikidata), ms: 1 }),
  rce: async () => ({ ok: true, body: read(rce), ms: 1 }),
});

let db: TestDb;
let client: pg.Client;
const hb = join(mkdtempSync(join(tmpdir(), 'mjk-main-')), 'heartbeat');

beforeAll(async () => {
  db = await createMigratedDb();
  client = new pg.Client({ connectionString: db.urls.mjk_worker });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await db.drop();
});

const asWorker = () => ({ PATH: process.env.PATH, DATABASE_URL: db.urls.mjk_worker });

it('sync-museums --seed --dry-run prints a summary of counts and writes nothing', async () => {
  const out: string[] = [];
  const code = await run(['sync-museums', '--seed', '--dry-run'], asWorker(), () => {}, hb, {
    out: (l) => out.push(l),
    // The fixtures are small; the role's own floors (1,000 and 500 rows) refuse them, which is the point here.
    fetchers: fixtures('wikidata/normal', 'rce/normal'),
  });
  expect(code).toBe(EXIT_REFUSED);
  const summary = JSON.parse(out.join('\n'));
  expect(summary).toMatchObject({ mode: 'seed', dryRun: true, outcome: 'refused', code: 'empty_guard' });
  expect(summary.sources.wikidata.status).toBe('below_floor');
  expect((await client.query('SELECT count(*)::int AS n FROM museum_sync_run')).rows[0].n).toBe(0);
});

it('sync-museums --accept-drop lets one source below its floor through, and records the refusal of the other', async () => {
  const out: string[] = [];
  // The recorded RCE answer (629 rows) passes its 500-row floor; its first 100 features do not.
  const rce = read('rce/normal') as { features: unknown[] };
  const code = await run(['sync-museums', '--seed', '--accept-drop', 'wikidata'], asWorker(), () => {}, hb, {
    out: (l) => out.push(l),
    fetchers: {
      wikidata: fixtures('wikidata/normal', 'rce/normal').wikidata,
      rce: async () => ({ ok: true, body: { ...rce, features: rce.features.slice(0, 100) }, ms: 1 }),
    },
  });
  expect(code).toBe(EXIT_REFUSED);
  const summary = JSON.parse(out.join('\n'));
  expect(summary.sources).toMatchObject({ wikidata: { status: 'ok' }, rce: { status: 'below_floor' } });
  const runs = await client.query('SELECT mode, outcome, code, accept_drop FROM museum_sync_run');
  expect(runs.rows).toEqual([{ mode: 'seed', outcome: 'refused', code: 'empty_guard', accept_drop: 'wikidata' }]);
  expect((await client.query('SELECT count(*)::int AS n FROM museum')).rows[0].n).toBe(0);
});

it('worker runs a queued museum_sync job with the sync handler, then stops on the signal', async () => {
  const pool = createPool('mjk_worker', asWorker(), { max: 2 });
  if (typeof pool === 'string') throw new Error(pool);
  const kdb = createDb(pool);
  try {
    await enqueue(kdb, 'museum_sync');
    const stop = new AbortController();
    const exit = run(['worker'], asWorker(), () => {}, hb, {
      fetchers: fixtures('wikidata/normal', 'rce/normal'),
      signal: stop.signal,
    });
    // The table is empty, so the weekly mode refuses: not_seeded is final, after one attempt.
    let job: { state: string; last_error: string | null; attempts: number } | undefined;
    for (let i = 0; i < 100; i++) {
      job = await kdb.selectFrom('job').select(['state', 'last_error', 'attempts']).executeTakeFirst();
      if (job?.state === 'failed' || job?.state === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    stop.abort();
    expect(await exit).toBe(0);
    expect(job).toEqual({ state: 'failed', last_error: 'not_seeded', attempts: 1 });
    expect(existsSync(hb)).toBe(true);
  } finally {
    await kdb.destroy();
  }
});

it('admin runs as mjk_api', async () => {
  const out: string[] = [];
  const code = await run(
    ['admin', 'list', 'show'],
    { PATH: process.env.PATH, DATABASE_URL: db.urls.mjk_api },
    () => {},
    hb,
    {
      out: (l) => out.push(l),
    },
  );
  expect(code).toBe(0);
  expect(out).toEqual(['no list published']);
});
