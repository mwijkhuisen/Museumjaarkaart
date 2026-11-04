import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { backoff } from '../../src/worker/backoff.ts';
import {
  claim,
  claimQuery,
  complete,
  enqueue,
  enqueueUnique,
  fail,
  LEASE_SECONDS,
  reap,
} from '../../src/worker/queue.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The job queue as mjk_worker. The superuser is used only to empty the table between tests
// (nobody has DELETE on `job`, by design).

let testDb: TestDb;
let admin: pg.Client;
const pools: pg.Pool[] = [];
const clients: pg.Client[] = [];

/** A Kysely instance over a pool of its own, logged in as mjk_worker. */
function workerDb(max = 3): Db {
  const pool = createPool('mjk_worker', { DATABASE_URL: testDb.urls.mjk_worker }, { max });
  if (typeof pool === 'string') throw new Error(pool);
  pools.push(pool);
  return createDb(pool);
}

let db: Db;

beforeAll(async () => {
  testDb = await createMigratedDb();
  admin = new pg.Client({ connectionString: testDb.urls.admin });
  await admin.connect();
  db = workerDb(4);
});
beforeEach(async () => {
  await admin.query('TRUNCATE job RESTART IDENTITY');
});
afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await admin?.end();
  for (const p of pools) await p.end().catch(() => {});
  await testDb?.drop();
});

const rows = () => db.selectFrom('job').selectAll().orderBy('id').execute();
const row = (id: string) => db.selectFrom('job').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

it('two workers with separate pools take 200 jobs at once and every job runs exactly once', async () => {
  await Promise.all(Array.from({ length: 200 }, (_, i) => enqueue(db, 'museum_sync', { n: i })));

  const claimers = [workerDb(), workerDb()];
  const seen: string[] = [];
  const loop = async (d: Db, workerId: string) => {
    for (;;) {
      const job = await claim(d, workerId, { leaseSeconds: LEASE_SECONDS });
      if (job === undefined) return;
      seen.push(job.id);
      expect(await complete(d, job, workerId)).toBe(true);
    }
  };
  const started = performance.now();
  // Two claim loops per worker, so up to four statements race for the same rows.
  await Promise.all(claimers.flatMap((d, i) => [loop(d, `w${i}-a`), loop(d, `w${i}-b`)]));
  const ms = Math.round(performance.now() - started);
  console.info(`200-job claim test: ${ms} ms`);

  expect(seen).toHaveLength(200);
  expect(new Set(seen).size).toBe(200);
  const all = await rows();
  expect(all).toHaveLength(200);
  expect(all.every((r) => r.state === 'done' && r.attempts === 1 && r.finished_at !== null)).toBe(true);
});

it('skips a row that another open transaction holds FOR UPDATE', async () => {
  const first = await enqueue(db, 'museum_sync');
  const second = await enqueue(db, 'museum_sync');
  const holder = new pg.Client({ connectionString: testDb.urls.mjk_worker });
  clients.push(holder);
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM job WHERE id = $1 FOR UPDATE', [first]);
  try {
    const a = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
    expect(a?.id).toBe(second);
    expect(await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();
  } finally {
    await holder.query('ROLLBACK');
  }
  expect((await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS }))?.id).toBe(first);
});

it('a failing job backs off, then ends failed with its fixed code', async () => {
  const id = await enqueue(db, 'museum_sync', {}, { maxAttempts: 3 });
  for (const attempt of [1, 2]) {
    const job = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
    expect(job?.id).toBe(id);
    expect(job?.attempts).toBe(attempt);
    expect(await fail(db, job as NonNullable<typeof job>, 'w1', 'upstream_down', true)).toBe('queued');

    const r = await row(id);
    expect(r).toMatchObject({ state: 'queued', last_error: 'upstream_down', locked_by: null, locked_at: null });
    // run_at against the database's own clock.
    const { rows: delta } = await sql<{
      s: number;
    }>`SELECT extract(epoch FROM run_at - now())::float8 AS s FROM job`.execute(db);
    expect(Math.abs((delta[0]?.s ?? 0) - backoff(attempt) / 1000)).toBeLessThan(5);
    // Not due yet.
    expect(await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();
    await sql`UPDATE job SET run_at = now()`.execute(db);
  }
  const last = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  expect(last?.attempts).toBe(3);
  expect(await fail(db, last as NonNullable<typeof last>, 'w1', 'upstream_down', true)).toBe('failed');
  const r = await row(id);
  expect(r).toMatchObject({ state: 'failed', last_error: 'upstream_down', attempts: 3 });
  expect(r.finished_at).not.toBeNull();
  expect(await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();
});

it('fails at once when the error says not to retry, and stores `internal` for a code that is not fixed', async () => {
  const a = await enqueue(db, 'museum_sync');
  const jobA = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  expect(await fail(db, jobA as NonNullable<typeof jobA>, 'w1', 'empty_guard', false)).toBe('failed');
  expect((await row(a)).last_error).toBe('empty_guard');

  const b = await enqueue(db, 'museum_sync');
  const jobB = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  await fail(db, jobB as NonNullable<typeof jobB>, 'w1', 'Not A Code: someone@example.invalid', false);
  expect((await row(b)).last_error).toBe('internal');
});

it('claims a job again once its lease has expired, and the old worker can no longer overwrite it', async () => {
  const id = await enqueue(db, 'museum_sync');
  const old = await claim(db, 'old', { leaseSeconds: LEASE_SECONDS });
  expect(old?.attempts).toBe(1);
  // A live lease is not taken over.
  expect(await claim(db, 'new', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();

  await sql`UPDATE job SET locked_at = now() - make_interval(secs => ${LEASE_SECONDS + 60})`.execute(db);
  const taken = await claim(db, 'new', { leaseSeconds: LEASE_SECONDS });
  expect(taken).toMatchObject({ id, attempts: 2, locked_by: 'new', state: 'running' });

  expect(await complete(db, old as NonNullable<typeof old>, 'old')).toBe(false);
  expect(await fail(db, old as NonNullable<typeof old>, 'old', 'internal', true)).toBeUndefined();
  expect(await row(id)).toMatchObject({ state: 'running', locked_by: 'new', attempts: 2 });

  expect(await complete(db, taken as NonNullable<typeof taken>, 'new')).toBe(true);
  expect(await row(id)).toMatchObject({ state: 'done', locked_by: null });
});

it('reap fails an expired running job that is out of attempts, with lease_expired', async () => {
  const id = await enqueue(db, 'museum_sync', {}, { maxAttempts: 1 });
  const other = await enqueue(db, 'other_kind', {}, { maxAttempts: 2 });
  await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  // A live lease is left alone.
  expect(await reap(db, { leaseSeconds: LEASE_SECONDS })).toBe(0);

  await sql`UPDATE job SET locked_at = now() - make_interval(secs => ${LEASE_SECONDS + 60})`.execute(db);
  // Out of attempts: no claim takes it.
  expect((await claim(db, 'w2', { leaseSeconds: LEASE_SECONDS }))?.id).toBe(other);
  expect(await reap(db, { leaseSeconds: LEASE_SECONDS })).toBe(1);
  const r = await row(id);
  expect(r).toMatchObject({ state: 'failed', last_error: 'lease_expired', attempts: 1, locked_by: null });
  expect(r.finished_at).not.toBeNull();
  // The job that still had an attempt was claimed again, not failed.
  expect(await row(other)).toMatchObject({ state: 'running', attempts: 2, locked_by: 'w2' });
});

it('enqueue sends a NOTIFY on mjk_job with the kind as payload, after the commit', async () => {
  const listener = new pg.Client({ connectionString: testDb.urls.mjk_worker });
  clients.push(listener);
  await listener.connect();
  const got = new Promise<pg.Notification>((resolve) => listener.once('notification', resolve));
  await listener.query('LISTEN mjk_job');
  const id = await enqueue(db, 'museum_sync');
  const note = await got;
  expect(note.channel).toBe('mjk_job');
  expect(note.payload).toBe('museum_sync');
  expect((await row(id)).state).toBe('queued');
});

it('enqueueUnique inserts once, even when 10 calls run concurrently', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => enqueueUnique(db, 'museum_sync', {})));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await rows()).toHaveLength(1);

  // A running job still counts; a finished one does not.
  const job = await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS });
  expect(await enqueueUnique(db, 'museum_sync', {})).toBe(false);
  await complete(db, job as NonNullable<typeof job>, 'w1');
  expect(await enqueueUnique(db, 'museum_sync', {})).toBe(true);
  // Another kind is independent.
  expect(await enqueueUnique(db, 'other_kind', {})).toBe(true);
});

it('refuses a bad kind, payload or option before any SQL', async () => {
  const bad = ['', 'Upper', 'has space', 'a1', "x'); DROP TABLE job; --", 'x'.repeat(41), 'museum-sync'];
  for (const kind of bad) {
    await expect(enqueue(db, kind)).rejects.toThrow('enqueue: invalid kind');
    await expect(enqueueUnique(db, kind, {})).rejects.toThrow('enqueue: invalid kind');
  }
  await expect(enqueue(db, 'museum_sync', [] as never)).rejects.toThrow('enqueue: invalid payload');
  await expect(enqueue(db, 'museum_sync', null as never)).rejects.toThrow('enqueue: invalid payload');
  await expect(enqueue(db, 'museum_sync', { big: 'x'.repeat(9_000) })).rejects.toThrow('enqueue: invalid payload');
  await expect(enqueue(db, 'museum_sync', {}, { maxAttempts: 0 })).rejects.toThrow('enqueue: invalid options');
  await expect(enqueue(db, 'museum_sync', {}, { maxAttempts: 21 })).rejects.toThrow('enqueue: invalid options');
  expect(await rows()).toHaveLength(0);
});

it('stores the payload and honours runAt', async () => {
  const later = new Date(Date.now() + 3_600_000);
  const id = await enqueue(db, 'museum_sync', { run: 'abc', n: 3 }, { runAt: later });
  const r = await row(id);
  expect(r.payload).toEqual({ run: 'abc', n: 3 });
  expect(Math.abs(r.run_at.getTime() - later.getTime())).toBeLessThan(1_000);
  expect(await claim(db, 'w1', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();
});

it('compiles the claim into one UPDATE with a SKIP LOCKED subselect', () => {
  const { sql: text, parameters } = claimQuery(db, 'w1', LEASE_SECONDS).compile();
  console.info(`claim SQL: ${text}\nparameters: ${JSON.stringify(parameters)}`);
  expect(text).toMatch(/^update "job" set /);
  expect(text).toContain('for update skip locked');
  expect(text).toContain('returning *');
  expect(parameters).toContain('w1');
});
