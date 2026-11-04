// One museum sync run (A§7.4, plan §2.4): the weekly worker job and the
// `sync-museums` role call the same runSync(). It runs as mjk_worker, so the
// grants (not just this code) keep it off the curated columns and the lists.
//
// lock → fetch and parse both sources → empty guard → load state, plan, the
// mass-change brake, apply in one transaction → one log line of counts. A dry
// run computes the same plan inside a READ ONLY transaction and writes nothing,
// not even a run row.

import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { applyPlan, loadState } from './apply.ts';
import { type Counts, DEFAULT_PLAN_CONFIG, type Plan, type PlanConfig, plan } from './diff.ts';
import type { Source } from './fields.ts';
import { parseRce } from './sources/rce.ts';
import type { ParseResult, RceRow, SourceErrorCode, WikidataRow } from './sources/types.ts';
import { parseWikidata } from './sources/wikidata.ts';

/** What a fetcher returns: the JSON body, or a fixed code (sources/http.ts). */
export type FetchResult = { ok: true; body: unknown; ms: number } | { ok: false; code: SourceErrorCode };
export type Fetchers = Record<Source, () => Promise<FetchResult>>;

export type SyncConfig = {
  /** First run: the minimum rows per source [U]. */
  floors: Record<Source, number>;
  /** A source under this share of the last applied run's rows applies nothing [U]. */
  minShare: number;
  /** More invalid rows than this share applies nothing [U]. */
  maxInvalidShare: number;
  /**
   * The mass-change brake [U]: a sync that would apply safe changes to more than this share of the
   * museums held applies nothing (a source that reloaded or renumbered its rows, such as RCE's
   * positional feature ids, would otherwise put a neighbour's address on many museums at once).
   */
  maxChangedShare: number;
  /** The brake trips only from this many changed museums on, so a small catalogue is not stuck. */
  minChanged: number;
  plan: PlanConfig;
};

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  floors: { wikidata: 1000, rce: 500 },
  minShare: 0.9,
  maxInvalidShare: 0.02,
  maxChangedShare: 0.1,
  minChanged: 50,
  plan: DEFAULT_PLAN_CONFIG,
};

export type SyncOptions = {
  mode: 'seed' | 'sync';
  dryRun?: boolean;
  acceptDrop?: Source | null;
  /** Lets this one run past the mass-change brake (the owner has looked at the dry run). */
  acceptChanges?: boolean;
};

export type GuardReason = 'schema' | 'invalid_rows' | 'below_baseline' | 'below_floor';

export type Outcome = 'applied' | 'dry_run' | 'refused' | 'failed';

/**
 * The fixed codes of a run that did not apply:
 * - `sync_busy`: another run holds the lock
 * - `<source>_unavailable`: a source could not be fetched (retried)
 * - `empty_guard`: a source failed its schema, row count or invalid share (not retried)
 * - `mass_change`: the plan would apply safe changes to too many museums at once (not retried)
 * - `not_seeded` / `already_seeded`: the wrong mode for the table
 * - `apply_failed`: the transaction failed
 */
export type SyncCode =
  | 'sync_busy'
  | 'wikidata_unavailable'
  | 'rce_unavailable'
  | 'empty_guard'
  | 'mass_change'
  | 'not_seeded'
  | 'already_seeded'
  | 'apply_failed';

export type Summary = {
  mode: 'seed' | 'sync';
  dryRun: boolean;
  outcome: Outcome;
  code: SyncCode | null;
  /** Per source: the fetch error, the guard reason, or ok. */
  sources: Record<Source, { status: 'ok' | SourceErrorCode | GuardReason; rows: number; ms: number | null }>;
  invalid: Record<Source, Record<string, number>>;
  notes: Record<Source, Record<string, number>>;
  /** The baseline the guard compared with (the last applied run), or null on a first run. */
  baseline: Record<Source, number | null>;
  /** Coverage of the parsed rows: how many carry coordinates, a municipality, a postcode. */
  coverage: { wikidata: Record<string, number>; rce: Record<string, number> };
  counts: Counts | null;
  /** The mass-change brake: museums with an applied change in the plan, and museums held (sync only). */
  changed: { museums: number; held: number } | null;
};

export type SyncResult = { outcome: Outcome; code: SyncCode | null; runId: string | null; summary: Summary };

/** Thrown inside the apply transaction when the brake trips, so that it rolls back. */
class MassChange extends Error {}

/** One key for every museum sync (pg_try_advisory_lock). */
const LOCK_KEY = 61_000_001;

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function guard(
  source: Source,
  parsed: ParseResult<unknown>,
  baseline: number | null,
  cfg: SyncConfig,
  acceptDrop: Source | null,
): GuardReason | null {
  if (!parsed.ok) return 'schema';
  const n = parsed.rows.length;
  const bad = sum(parsed.invalid);
  if (n + bad > 0 && bad / (n + bad) > cfg.maxInvalidShare) return 'invalid_rows';
  if (acceptDrop === source) return null;
  if (baseline === null) return n < cfg.floors[source] ? 'below_floor' : null;
  return n < cfg.minShare * baseline ? 'below_baseline' : null;
}

/** The museums the plan would change by itself: those with an applied (safe) change. */
export function changedMuseums(p: Plan): number {
  return new Set(p.changes.filter((c) => c.state === 'applied').map((c) => c.museumId)).size;
}

/** True when the brake stops the plan: at least `minChanged` museums, and more than the share of those held. */
export function tripsBrake(changed: number, held: number, cfg: SyncConfig): boolean {
  return changed >= cfg.minChanged && changed > cfg.maxChangedShare * held;
}

function coverage(w: readonly WikidataRow[], r: readonly RceRow[]) {
  const count = <T>(rows: readonly T[], f: (x: T) => boolean) => rows.filter(f).length;
  return {
    wikidata: {
      rows: w.length,
      coordinates: count(w, (x) => x.lat !== null),
      municipality: count(w, (x) => x.municipalityCode !== null),
      postcode: count(w, (x) => x.postcode !== null),
      street: count(w, (x) => x.street !== null),
      dissolved: count(w, (x) => x.dissolvedOn !== null),
      registered: count(w, (x) => x.registered),
      commons_file: count(w, (x) => x.commonsFile !== null),
    },
    rce: {
      rows: r.length,
      coordinates: count(r, (x) => x.lat !== null),
      postcode: count(r, (x) => x.postcode !== null),
    },
  };
}

/** The log line: numbers and fixed codes only, flattened (invariant 8). */
export function logFields(s: Summary): Record<string, number | string | boolean | null> {
  const out: Record<string, number | string | boolean | null> = {
    mode: s.mode,
    dry_run: s.dryRun,
    outcome: s.outcome,
    code: s.code,
  };
  const flat = (prefix: string, value: unknown) => {
    if (typeof value === 'number' || typeof value === 'boolean') out[prefix] = value;
    else if (typeof value === 'string') out[prefix] = value;
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) flat(`${prefix}_${k}`, v);
    }
  };
  for (const source of ['wikidata', 'rce'] as const) {
    flat(`${source}_status`, s.sources[source].status);
    flat(`${source}_rows`, s.sources[source].rows);
    if (s.sources[source].ms !== null) flat(`${source}_ms`, s.sources[source].ms);
    flat(`${source}_invalid`, s.invalid[source]);
    flat(`${source}_notes`, s.notes[source]);
  }
  if (s.counts) flat('count', s.counts);
  if (s.changed) flat('changed', s.changed);
  return out;
}

export async function runSync(
  db: Db,
  fetchers: Fetchers,
  logger: Logger,
  opts: SyncOptions,
  cfg: SyncConfig = DEFAULT_SYNC_CONFIG,
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? false;
  const acceptDrop = opts.acceptDrop ?? null;
  const acceptChanges = opts.acceptChanges ?? false;
  const summary: Summary = {
    mode: opts.mode,
    dryRun,
    outcome: 'failed',
    code: null,
    sources: { wikidata: { status: 'ok', rows: 0, ms: null }, rce: { status: 'ok', rows: 0, ms: null } },
    invalid: { wikidata: {}, rce: {} },
    notes: { wikidata: {}, rce: {} },
    baseline: { wikidata: null, rce: null },
    coverage: { wikidata: {}, rce: {} },
    counts: null,
    changed: null,
  };
  const finish = (outcome: Outcome, code: SyncCode | null, runId: string | null): SyncResult => {
    summary.outcome = outcome;
    summary.code = code;
    const fields = logFields(summary);
    if (outcome === 'applied' || outcome === 'dry_run') logger.info(fields, `sync_${outcome}`);
    else logger.warn(fields, `sync_${outcome}`);
    return { outcome, code, runId, summary };
  };

  return db.connection().execute(async (conn) => {
    const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`.execute(conn);
    if (!lock.rows[0]?.ok) return finish('failed', 'sync_busy', null);
    try {
      return await locked();
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
    }
  });

  async function record(outcome: 'refused' | 'failed', code: SyncCode): Promise<string | null> {
    if (dryRun) return null;
    const row = await db
      .insertInto('museum_sync_run')
      .values({
        mode: opts.mode,
        finished_at: sql<Date>`now()`,
        wikidata_rows: summary.sources.wikidata.rows,
        rce_rows: summary.sources.rce.rows,
        counts: JSON.stringify(logFields(summary)),
        outcome,
        code,
        accept_drop: acceptDrop,
        accept_changes: acceptChanges,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function locked(): Promise<SyncResult> {
    const museums = await db.selectFrom('museum').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    if (opts.mode === 'sync' && museums.n === 0)
      return finish('refused', 'not_seeded', await record('refused', 'not_seeded'));
    if (opts.mode === 'seed' && museums.n > 0) {
      return finish('refused', 'already_seeded', await record('refused', 'already_seeded'));
    }

    // One request per source and run (the fetchers retry 429 and 503 themselves).
    const [wf, rf] = await Promise.all([fetchers.wikidata(), fetchers.rce()]);
    for (const [source, f] of [
      ['wikidata', wf],
      ['rce', rf],
    ] as const) {
      if (f.ok) summary.sources[source].ms = f.ms;
      else summary.sources[source].status = f.code;
    }
    if (!wf.ok) return finish('failed', 'wikidata_unavailable', await record('failed', 'wikidata_unavailable'));
    if (!rf.ok) return finish('failed', 'rce_unavailable', await record('failed', 'rce_unavailable'));

    const w = parseWikidata(wf.body);
    const r = parseRce(rf.body);
    for (const [source, p] of [
      ['wikidata', w],
      ['rce', r],
    ] as const) {
      if (!p.ok) continue;
      summary.sources[source].rows = p.rows.length;
      summary.invalid[source] = p.invalid;
      summary.notes[source] = p.notes;
    }

    // The empty guard (F1's pattern): its baseline is the last *applied* run.
    const last = await db
      .selectFrom('museum_sync_run')
      .select(['wikidata_rows', 'rce_rows'])
      .where('outcome', '=', 'applied')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    summary.baseline = { wikidata: last?.wikidata_rows ?? null, rce: last?.rce_rows ?? null };
    const reasons = {
      wikidata: guard('wikidata', w, summary.baseline.wikidata, cfg, acceptDrop),
      rce: guard('rce', r, summary.baseline.rce, cfg, acceptDrop),
    };
    for (const source of ['wikidata', 'rce'] as const) {
      const reason = reasons[source];
      if (reason !== null) summary.sources[source].status = reason;
    }
    if (reasons.wikidata !== null || reasons.rce !== null || !w.ok || !r.ok) {
      return finish('refused', 'empty_guard', await record('refused', 'empty_guard'));
    }
    summary.coverage = coverage(w.rows, r.rows);
    const sources = { wikidata: w.rows, rce: r.rows };

    /**
     * The mass-change brake (the seed is exempt: it creates every museum). It records the counts either
     * way, so a refused run shows what it would have applied.
     */
    const braked = (p: Plan, held: number): boolean => {
      summary.counts = p.counts;
      if (opts.mode === 'seed') return false;
      summary.changed = { museums: changedMuseums(p), held };
      return !acceptChanges && tripsBrake(summary.changed.museums, held, cfg);
    };

    if (dryRun) {
      const stopped = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (tx) => {
          const state = await loadState(tx);
          return braked(plan(state, sources, opts.mode, cfg.plan), state.museums.length);
        });
      if (stopped) return finish('refused', 'mass_change', null);
      return finish('dry_run', null, null);
    }

    const run = await db
      .insertInto('museum_sync_run')
      .values({ mode: opts.mode, accept_drop: acceptDrop, accept_changes: acceptChanges })
      .returning('id')
      .executeTakeFirstOrThrow();
    let p: Plan;
    try {
      p = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (tx) => {
          const state = await loadState(tx);
          const planned = plan(state, sources, opts.mode, cfg.plan);
          // Nothing is written: the transaction rolls back and the run row is marked refused below.
          if (braked(planned, state.museums.length)) throw new MassChange();
          await applyPlan(tx, planned, run.id);
          summary.counts = planned.counts;
          await tx
            .updateTable('museum_sync_run')
            .set({
              finished_at: sql<Date>`now()`,
              wikidata_rows: w.rows.length,
              rce_rows: r.rows.length,
              counts: JSON.stringify(logFields({ ...summary, outcome: 'applied' })),
              outcome: 'applied',
            })
            .where('id', '=', run.id)
            .execute();
          return planned;
        });
    } catch (err) {
      if (err instanceof MassChange) {
        await db
          .updateTable('museum_sync_run')
          .set({
            finished_at: sql<Date>`now()`,
            wikidata_rows: w.rows.length,
            rce_rows: r.rows.length,
            counts: JSON.stringify(logFields({ ...summary, outcome: 'refused', code: 'mass_change' })),
            outcome: 'refused',
            code: 'mass_change',
          })
          .where('id', '=', run.id)
          .execute();
        return finish('refused', 'mass_change', run.id);
      }
      // No message: it can quote a value (A§17.2, invariant 8).
      summary.counts = null;
      summary.changed = null;
      await db
        .updateTable('museum_sync_run')
        .set({ finished_at: sql<Date>`now()`, outcome: 'failed', code: 'apply_failed' })
        .where('id', '=', run.id)
        .execute();
      return finish('failed', 'apply_failed', run.id);
    }
    summary.counts = p.counts;
    return finish('applied', null, run.id);
  }
}
