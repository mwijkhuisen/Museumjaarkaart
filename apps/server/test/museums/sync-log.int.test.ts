import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { DEFAULT_PLAN_CONFIG } from '../../src/museums/diff.ts';
import { type Fetchers, type FetchResult, runSync, type SyncConfig } from '../../src/museums/sync.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { week2 } from '../fixtures/museums/week2.ts';

// Invariant 8 for the sync: whatever the sources contain, the log lines hold fixed codes and
// counts only. The hostile fixtures (markup, bidi marks, controls, credentials in URLs) run
// through a seed, a sync with changes, a dry run, a refusal and a failed fetch as mjk_worker.

const FIXTURES = fileURLToPath(new URL('../fixtures/museums/', import.meta.url));
const read = (source: 'wikidata' | 'rce', name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${source}/${name}.json`, 'utf8'));

type SparqlAnswer = Parameters<typeof week2>[0];
type RceAnswer = { features: unknown[] };
const normalWikidata = read('wikidata', 'normal') as SparqlAnswer;
const hostileWikidata = read('wikidata', 'hostile') as SparqlAnswer;
const normalRce = read('rce', 'normal') as RceAnswer;
const hostileRce = read('rce', 'hostile') as RceAnswer;

const withHostile = (w: SparqlAnswer): SparqlAnswer => ({
  ...w,
  results: { bindings: [...w.results.bindings, ...hostileWikidata.results.bindings] },
});
const rce = { ...normalRce, features: [...normalRce.features, ...hostileRce.features] };

const ok = (body: unknown): FetchResult => ({ ok: true, body, ms: 7 });
const serve = (wikidata: unknown, rceBody: unknown): Fetchers => ({
  wikidata: async () => ok(wikidata),
  rce: async () => ok(rceBody),
});

const CFG: SyncConfig = {
  floors: { wikidata: 10, rce: 10 },
  minShare: 0.9,
  maxInvalidShare: 0.5, // the hostile rows are invalid on purpose; this test is about the log, not the guard
  plan: DEFAULT_PLAN_CONFIG,
};

/** Every string value of the hostile answers, raw: names, aliases, descriptions, addresses, URLs. */
function strings(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node === 'string') out.add(node);
  else if (Array.isArray(node)) for (const v of node) strings(v, out);
  else if (node !== null && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) if (k !== 'head') strings(v, out); // head.vars lists variable names
  return out;
}
// Short values ('nl', 'literal', 'uri') are protocol words, not content; a log code could equal one.
const SECRETS = [...strings(hostileWikidata), ...strings(hostileRce)].filter((s) => s.length >= 6);

let test: TestDb;
let db: Db;
beforeAll(async () => {
  test = await createMigratedDb();
  const pool = createPool('mjk_worker', { DATABASE_URL: test.urls.mjk_worker }, { max: 3 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
});
afterAll(async () => {
  await db.destroy();
  await test.drop();
});

describe('the sync log with hostile sources (invariant 8)', () => {
  it('writes one line per run, with fixed codes and numbers only', async () => {
    const { logger, lines } = memoryLogger('worker');
    const { answer } = week2(normalWikidata);
    const runs: [string, () => ReturnType<typeof runSync>][] = [
      ['sync_applied', () => runSync(db, serve(withHostile(normalWikidata), rce), logger, { mode: 'seed' }, CFG)],
      ['sync_dry_run', () => runSync(db, serve(withHostile(answer), rce), logger, { mode: 'sync', dryRun: true }, CFG)],
      ['sync_applied', () => runSync(db, serve(withHostile(answer), rce), logger, { mode: 'sync' }, CFG)],
      ['sync_refused', () => runSync(db, serve(read('wikidata', 'empty'), rce), logger, { mode: 'sync' }, CFG)],
      [
        'sync_failed',
        () =>
          runSync(
            db,
            { wikidata: async () => ({ ok: false, code: 'timeout' }), rce: async () => ok(rce) },
            logger,
            { mode: 'sync' },
            CFG,
          ),
      ],
    ];
    const expectedMsgs: string[] = [];
    for (const [msg, go] of runs) {
      const before = lines().length;
      await go();
      const added = lines().slice(before);
      expect(added, msg).toHaveLength(1);
      expect(added[0]?.msg).toBe(msg);
      expectedMsgs.push(msg);
    }
    const out = lines();
    expect(out.map((l) => l.msg)).toEqual(expectedMsgs);

    const text = out.map((l) => JSON.stringify(l)).join('\n');
    expect(SECRETS.length).toBeGreaterThan(10);
    for (const s of SECRETS)
      expect(text.includes(s), `source string reached the log: ${JSON.stringify(s.slice(0, 40))}`).toBe(false);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i);
    for (const bad of ['</script>', '<img', 'onerror']) expect(text.toLowerCase()).not.toContain(bad);
    // JSON escapes controls, so test the parsed values too: bidi, zero-width and control characters.
    for (const line of out) {
      for (const [k, v] of Object.entries(line)) {
        expect(`${k}=${String(v)}`).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }
    }
    for (const url of Object.values(test.urls)) {
      const u = new URL(url);
      expect(text).not.toContain(u.password);
      expect(text).not.toContain(url);
    }

    // Values: numbers, booleans, null, or a fixed code; `time` is pino's ISO timestamp.
    for (const line of out) {
      for (const [k, v] of Object.entries(line)) {
        if (k === 'time') continue;
        if (typeof v === 'number' || typeof v === 'boolean' || v === null) continue;
        expect(typeof v, k).toBe('string');
        if (k === 'role') expect(v).toBe('worker');
        else if (k === 'mode') expect(['seed', 'sync']).toContain(v);
        else expect(v as string, k).toMatch(/^[a-z0-9_]{1,40}$/);
      }
    }
  });
});
