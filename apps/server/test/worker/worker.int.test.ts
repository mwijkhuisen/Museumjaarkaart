import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { backoff } from '../../src/worker/backoff.ts';
import { enqueue } from '../../src/worker/queue.ts';
import { JobError, type JobHandler } from '../../src/worker/types.ts';
import { runWorker } from '../../src/worker/worker.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The worker loop as mjk_worker against a real PostgreSQL (NOTIFY, poll, abort, heartbeat, error codes).

let testDb: TestDb;
let admin: pg.Client;
let db: Db;
const pools: pg.Pool[] = [];
const running: { ac: AbortController; done: Promise<void> }[] = [];

const poolFor = (url: string, max = 3) => {
  const pool = createPool('mjk_worker', { DATABASE_URL: url }, { max });
  if (typeof pool === 'string') throw new Error(pool);
  pools.push(pool);
  return pool;
};
const listenOk = () => new pg.Client({ connectionString: testDb.urls.mjk_worker });
// Port 1 refuses at once: a LISTEN client that always fails.
const listenBroken = () => new pg.Client({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' });

beforeAll(async () => {
  testDb = await createMigratedDb();
  admin = new pg.Client({ connectionString: testDb.urls.admin });
  await admin.connect();
  db = createDb(poolFor(testDb.urls.mjk_worker));
});
beforeEach(async () => {
  await admin.query('TRUNCATE job RESTART IDENTITY');
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.ac.abort();
    await r.done;
  }
});
afterAll(async () => {
  await admin?.end();
  for (const p of pools) await p.end().catch(() => {});
  await testDb?.drop();
});

const tmpHeartbeat = () => join(mkdtempSync(join(tmpdir(), 'mjk-hb-')), 'heartbeat');

function start(handlers: Record<string, JobHandler>, over: Partial<Parameters<typeof runWorker>[0]> = {}) {
  const ac = new AbortController();
  const mem = memoryLogger('worker');
  const heartbeatPath = tmpHeartbeat();
  const done = runWorker({
    db,
    listen: listenOk,
    handlers,
    logger: mem.logger,
    signal: ac.signal,
    workerId: 'w-test',
    pollMs: 60_000,
    heartbeatPath,
    ...over,
  });
  running.push({ ac, done });
  return { ac, done, heartbeatPath, ...mem };
}

const row = (id: string) => db.selectFrom('job').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** True once a session has run `LISTEN mjk_job` and is idle. */
async function listening() {
  const { rows } = await admin.query(
    `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle' AND query = 'LISTEN mjk_job'`,
  );
  return rows.length > 0;
}

it('runs a job enqueued while the loop idles within about a second (NOTIFY), with a 60 s poll', async () => {
  const ran = vi.fn(async () => {});
  const w = start({ museum_sync: ran });
  await vi.waitFor(async () => expect(await listening()).toBe(true), { timeout: 5_000, interval: 50 });
  await new Promise((r) => setTimeout(r, 300)); // let the reconnect catch-up claim finish: only a NOTIFY can wake it now
  const t0 = performance.now();
  const id = await enqueue(db, 'museum_sync', { run: 'r1' });
  await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), { timeout: 1_500, interval: 20 });
  expect(performance.now() - t0).toBeLessThan(1_500);
  expect(ran).toHaveBeenCalledWith({ run: 'r1' }, { signal: w.ac.signal });
  await vi.waitFor(async () => expect((await row(id)).state).toBe('done'), { timeout: 2_000 });
  expect(await row(id)).toMatchObject({ attempts: 1, last_error: null, locked_by: null });
  const done = w.lines().find((l) => l.msg === 'job_done');
  expect(done).toMatchObject({ role: 'worker', kind: 'museum_sync', id });
  expect(typeof done?.ms).toBe('number');
});

it('still picks a job up by the poll when the LISTEN client keeps failing', async () => {
  const ran = vi.fn(async () => {});
  const w = start({ museum_sync: ran }, { listen: listenBroken, pollMs: 100 });
  await enqueue(db, 'museum_sync');
  await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), { timeout: 3_000, interval: 20 });
  // One warning for the outage, not one per retry.
  expect(w.lines().filter((l) => l.msg === 'listen_unavailable')).toHaveLength(1);
});

it('on abort, the handler in flight finishes, then the loop resolves and claims nothing more', async () => {
  const gate = deferred();
  const started = deferred();
  const ran = vi.fn(async (_p: unknown, ctx: { signal: AbortSignal }) => {
    started.resolve();
    await gate.promise;
    expect(ctx.signal.aborted).toBe(true);
  });
  const w = start({ museum_sync: ran });
  const first = await enqueue(db, 'museum_sync');
  const second = await enqueue(db, 'museum_sync');
  await started.promise;

  w.ac.abort();
  let resolved = false;
  void w.done.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(resolved).toBe(false); // still waiting for the handler
  gate.resolve();
  await w.done;

  expect(ran).toHaveBeenCalledTimes(1);
  expect((await row(first)).state).toBe('done');
  expect((await row(second)).state).toBe('queued');
});

it('touches the heartbeat file after a database round trip', async () => {
  const w = start({}, { pollMs: 50 });
  await vi.waitFor(() => expect(existsSync(w.heartbeatPath)).toBe(true), { timeout: 3_000, interval: 20 });
  const first = statSync(w.heartbeatPath).mtimeMs;
  await vi.waitFor(() => expect(statSync(w.heartbeatPath).mtimeMs).toBeGreaterThan(first), {
    timeout: 3_000,
    interval: 20,
  });
});

it('keeps the heartbeat fresh with its own ping while a long job runs', async () => {
  const gate = deferred();
  const started = deferred();
  const w = start(
    {
      museum_sync: async () => {
        started.resolve();
        await gate.promise;
      },
    },
    { heartbeatMs: 50 },
  );
  await enqueue(db, 'museum_sync');
  await started.promise;
  await vi.waitFor(() => expect(existsSync(w.heartbeatPath)).toBe(true), { timeout: 3_000 });
  const first = statSync(w.heartbeatPath).mtimeMs;
  await vi.waitFor(() => expect(statSync(w.heartbeatPath).mtimeMs).toBeGreaterThan(first), { timeout: 3_000 });
  gate.resolve();
});

it('does not touch the heartbeat while the database is down, and logs db_unavailable once', async () => {
  const dead = createDb(poolFor('postgres://nobody:x@127.0.0.1:1/none'));
  const w = start({}, { db: dead, pollMs: 50, heartbeatMs: 50, listen: listenBroken });
  await new Promise((r) => setTimeout(r, 700));
  expect(existsSync(w.heartbeatPath)).toBe(false);
  expect(w.lines().filter((l) => l.msg === 'db_unavailable')).toHaveLength(1);
  expect(JSON.stringify(w.lines())).not.toContain('nobody');
});

it('fails a job of an unknown kind at once with unknown_kind', async () => {
  const w = start({});
  const id = await enqueue(db, 'no_such_kind');
  await vi.waitFor(async () => expect((await row(id)).state).toBe('failed'), { timeout: 3_000, interval: 20 });
  expect(await row(id)).toMatchObject({ last_error: 'unknown_kind', attempts: 1 });
  expect(w.lines().find((l) => l.msg === 'job_failed')).toMatchObject({ kind: 'no_such_kind', code: 'unknown_kind' });
});

it('does not take a handler from the object prototype for a kind such as `constructor`', async () => {
  start({});
  const id = await enqueue(db, 'constructor');
  await vi.waitFor(async () => expect((await row(id)).state).toBe('failed'), { timeout: 3_000, interval: 20 });
  expect((await row(id)).last_error).toBe('unknown_kind');
});

it('retries a JobError with its code at the backoff time, then fails with that code', async () => {
  const w = start(
    {
      museum_sync: async () => {
        throw new JobError('upstream_down');
      },
    },
    { pollMs: 100 },
  );
  const id = await enqueue(db, 'museum_sync', {}, { maxAttempts: 2 });
  await vi.waitFor(async () => expect((await row(id)).last_error).toBe('upstream_down'), {
    timeout: 3_000,
    interval: 20,
  });
  const r1 = await row(id);
  expect(r1).toMatchObject({ attempts: 1, last_error: 'upstream_down' });
  const { rows } = await sql<{ s: number }>`SELECT extract(epoch FROM run_at - now())::float8 AS s FROM job`.execute(
    db,
  );
  expect(Math.abs((rows[0]?.s ?? 0) - backoff(1) / 1000)).toBeLessThan(5);
  expect(w.lines().find((l) => l.msg === 'job_retry')).toMatchObject({ id, code: 'upstream_down', attempts: 1 });

  await sql`UPDATE job SET run_at = now()`.execute(db);
  await vi.waitFor(async () => expect((await row(id)).state).toBe('failed'), { timeout: 3_000, interval: 20 });
  const r2 = await row(id);
  expect(r2).toMatchObject({ attempts: 2, last_error: 'upstream_down' });
  expect(r2.finished_at).not.toBeNull();
  expect(w.lines().find((l) => l.msg === 'job_failed')).toMatchObject({ id, code: 'upstream_down' });
});

it('fails a JobError with retry false at once', async () => {
  start({
    museum_sync: async () => {
      throw new JobError('empty_guard', { retry: false });
    },
  });
  const id = await enqueue(db, 'museum_sync');
  await vi.waitFor(async () => expect((await row(id)).state).toBe('failed'), { timeout: 3_000, interval: 20 });
  expect(await row(id)).toMatchObject({ last_error: 'empty_guard', attempts: 1 });
});

it('stores `internal` for any other error and logs neither its message nor the address in it', async () => {
  const w = start(
    {
      museum_sync: async () => {
        throw new Error('mail to someone@example.invalid failed');
      },
    },
    { pollMs: 100 },
  );
  const id = await enqueue(db, 'museum_sync', {}, { maxAttempts: 1 });
  await vi.waitFor(async () => expect((await row(id)).state).toBe('failed'), { timeout: 3_000, interval: 20 });
  expect((await row(id)).last_error).toBe('internal');
  const text = JSON.stringify(w.lines());
  expect(text).not.toContain('someone@example.invalid');
  expect(text).not.toContain('mail to');
  expect(w.lines().find((l) => l.msg === 'job_failed')).toMatchObject({ id, code: 'internal' });
});

it('logs no payload', async () => {
  const w = start({ museum_sync: async () => {} });
  await enqueue(db, 'museum_sync', { secret_looking: 'payload-value-123' });
  await vi.waitFor(() => expect(w.lines().some((l) => l.msg === 'job_done')).toBe(true), { timeout: 3_000 });
  expect(JSON.stringify(w.lines())).not.toContain('payload-value-123');
});
