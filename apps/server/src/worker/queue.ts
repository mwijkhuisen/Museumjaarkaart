import { type Selectable, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { Job } from '../db/types.ts';
import { backoff } from './backoff.ts';
import { ERROR_CODE } from './types.ts';

// The job queue in PostgreSQL (A§8 `job`, ADR-0015, plan §2.5). Every statement goes
// through Kysely with bound parameters. `kind` and the stored error are fixed codes.

export type ClaimedJob = Selectable<Job>;

/** The lease of a running job [U]: the museum sync may run 30 minutes before another worker may take it over. */
export const LEASE_SECONDS = 30 * 60;

/** The Postgres channel a worker LISTENs on; the NOTIFY payload is the job kind. */
export const NOTIFY_CHANNEL = 'mjk_job';

const KIND = /^[a-z_]{1,40}$/;
const MAX_PAYLOAD_BYTES = 8 * 1024;

export type EnqueueOptions = { runAt?: Date; maxAttempts?: number };

/** Thrown before any SQL; the text is fixed and never quotes the input. */
function badInput(what: 'kind' | 'payload' | 'options'): never {
  throw new Error(`enqueue: invalid ${what}`);
}

function checkKind(kind: string): void {
  if (typeof kind !== 'string' || !KIND.test(kind)) badInput('kind');
}

/** A plain JSON object of ids, as text. */
function payloadText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) badInput('payload');
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) badInput('payload');
  let text: string | undefined;
  try {
    text = JSON.stringify(payload);
  } catch {
    badInput('payload');
  }
  if (text === undefined || text.length > MAX_PAYLOAD_BYTES) badInput('payload');
  return text;
}

/** INSERT plus NOTIFY in one transaction: a worker is only woken for a committed job. */
async function insertAndNotify(
  trx: Db,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  opts: EnqueueOptions,
): Promise<string> {
  const { maxAttempts } = opts;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)) {
    badInput('options');
  }
  if (opts.runAt !== undefined && Number.isNaN(opts.runAt.getTime())) badInput('options');
  const row = await trx
    .insertInto('job')
    .values({
      kind,
      payload: payloadText(payload),
      ...(opts.runAt === undefined ? {} : { run_at: opts.runAt }),
      ...(maxAttempts === undefined ? {} : { max_attempts: maxAttempts }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${kind})`.execute(trx);
  return row.id;
}

/** Queues a job and wakes the workers. Returns the job id. */
export async function enqueue(
  db: Db,
  kind: string,
  payload: Readonly<Record<string, unknown>> = {},
  opts: EnqueueOptions = {},
): Promise<string> {
  checkKind(kind);
  payloadText(payload);
  return db.transaction().execute((trx) => insertAndNotify(trx, kind, payload, opts));
}

/**
 * Queues a job unless one of that kind is already `queued` or `running`. The advisory
 * lock (per kind, released at commit) makes the check and the insert atomic.
 * Returns whether it inserted.
 */
export async function enqueueUnique(
  db: Db,
  kind: string,
  payload: Readonly<Record<string, unknown>> = {},
  opts: EnqueueOptions = {},
): Promise<boolean> {
  checkKind(kind);
  payloadText(payload);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('mjk_job:' || ${kind}::text))`.execute(trx);
    const open = await trx
      .selectFrom('job')
      .select('id')
      .where('kind', '=', kind)
      .where('state', 'in', ['queued', 'running'])
      .limit(1)
      .executeTakeFirst();
    if (open !== undefined) return false;
    await insertAndNotify(trx, kind, payload, opts);
    return true;
  });
}

/**
 * The claim, one statement: the next due `queued` job, or a `running` one whose lease
 * expired, that still has attempts left. SKIP LOCKED passes over a row another
 * transaction holds, so two workers never take the same job.
 */
export function claimQuery(db: Db, workerId: string, leaseSeconds: number) {
  return db
    .updateTable('job')
    .set({
      state: 'running',
      attempts: sql<number>`attempts + 1`,
      locked_at: sql<Date>`now()`,
      locked_by: workerId,
    })
    .where('id', '=', (eb) =>
      eb
        .selectFrom('job')
        .select('id')
        .where((w) =>
          w.and([
            w.or([
              w.and([w('state', '=', 'queued'), w('run_at', '<=', sql<Date>`now()`)]),
              w.and([
                w('state', '=', 'running'),
                w('locked_at', '<', sql<Date>`now() - make_interval(secs => ${leaseSeconds})`),
              ]),
            ]),
            w('attempts', '<', w.ref('max_attempts')),
          ]),
        )
        .orderBy('run_at')
        .orderBy('id')
        .limit(1)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll();
}

/** Takes the next job, or undefined when none is due. */
export async function claim(db: Db, workerId: string, opts: { leaseSeconds: number }): Promise<ClaimedJob | undefined> {
  return claimQuery(db, workerId, opts.leaseSeconds).executeTakeFirst();
}

/**
 * Fails a `running` job whose lease expired and whose attempts are used up: no worker
 * would claim it again. Returns how many rows it failed.
 */
export async function reap(db: Db, opts: { leaseSeconds: number }): Promise<number> {
  const r = await db
    .updateTable('job')
    .set({
      state: 'failed',
      last_error: 'lease_expired',
      finished_at: sql<Date>`now()`,
      locked_at: null,
      locked_by: null,
    })
    .where('state', '=', 'running')
    .where('locked_at', '<', sql<Date>`now() - make_interval(secs => ${opts.leaseSeconds})`)
    .where((w) => w('attempts', '>=', w.ref('max_attempts')))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * Marks the job done. Guarded by the owner: a worker whose lease was taken over cannot
 * overwrite the new owner. Returns whether a row changed.
 */
export async function complete(db: Db, job: Pick<ClaimedJob, 'id'>, workerId: string): Promise<boolean> {
  const r = await db
    .updateTable('job')
    .set({ state: 'done', finished_at: sql<Date>`now()`, locked_at: null, locked_by: null, last_error: null })
    .where('id', '=', job.id)
    .where('state', '=', 'running')
    .where('locked_by', '=', workerId)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}

/**
 * Records a failed attempt with the same owner guard. While `retry` and attempts are
 * left the job goes back to `queued` after the backoff; otherwise it is `failed`.
 * Returns the new state, or undefined when the guard held it back.
 */
export async function fail(
  db: Db,
  job: Pick<ClaimedJob, 'id' | 'attempts' | 'max_attempts'>,
  workerId: string,
  code: string,
  retry: boolean,
): Promise<'queued' | 'failed' | undefined> {
  const stored = ERROR_CODE.test(code) ? code : 'internal';
  const again = retry && job.attempts < job.max_attempts;
  const base = db
    .updateTable('job')
    .where('id', '=', job.id)
    .where('state', '=', 'running')
    .where('locked_by', '=', workerId);
  const r = again
    ? await base
        .set({
          state: 'queued',
          run_at: sql<Date>`now() + make_interval(secs => ${backoff(job.attempts) / 1000})`,
          locked_at: null,
          locked_by: null,
          last_error: stored,
        })
        .executeTakeFirst()
    : await base
        .set({ state: 'failed', finished_at: sql<Date>`now()`, locked_at: null, locked_by: null, last_error: stored })
        .executeTakeFirst();
  if (r.numUpdatedRows === 0n) return undefined;
  return again ? 'queued' : 'failed';
}
