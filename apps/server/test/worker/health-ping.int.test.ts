import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, HttpResponse, http } from 'msw';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { createPinger, type Pinger } from '../../src/lib/healthchecks.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { lastSyncIsFresh, pingWorkerHealth, startHealthPing } from '../../src/worker/health-ping.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The worker's hourly healthchecks ping as mjk_worker: green while the newest applied museum
// sync finished under 8 days ago, `/fail` otherwise (A§17.7). hc-ping.com is an msw handler.

// A 22-character URL-safe placeholder, built at run time so no key-shaped literal is committed.
const KEY = `${'k'.repeat(10)}_-${'k'.repeat(10)}`;
let testDb: TestDb;
let admin: pg.Client;
let pool: pg.Pool;
let db: Db;
let hits: string[];

const pinger = (): Pinger => {
  const dir = mkdtempSync(join(tmpdir(), 'mjk-hcp-'));
  writeFileSync(join(dir, 'hc_ping_key'), `${KEY}\n`);
  return createPinger({ logger: memoryLogger().logger, secretsDir: dir });
};

/** A finished run `ago` before now. */
const run = (outcome: string | null, ago: string, mode = 'sync') =>
  admin.query(
    `INSERT INTO museum_sync_run (mode, started_at, finished_at, outcome)
     VALUES ($1, now() - $2::interval - interval '1 minute', now() - $2::interval, $3)`,
    [mode, ago, outcome],
  );

beforeAll(async () => {
  testDb = await createMigratedDb();
  admin = new pg.Client({ connectionString: testDb.urls.admin });
  await admin.connect();
  const p = createPool('mjk_worker', { DATABASE_URL: testDb.urls.mjk_worker }, { max: 2 });
  if (typeof p === 'string') throw new Error(p);
  pool = p;
  db = createDb(pool);
});
afterAll(async () => {
  await db?.destroy();
  await admin?.end();
  await testDb?.drop();
});
beforeEach(async () => {
  await admin.query('DELETE FROM museum_sync_run');
  hits = [];
  server.use(
    http.post('https://hc-ping.com/:key/:slug', ({ params }) => {
      hits.push(`${params.slug}`);
      return new HttpResponse('OK');
    }),
    http.post('https://hc-ping.com/:key/:slug/fail', ({ params }) => {
      hits.push(`${params.slug}/fail`);
      return new HttpResponse('OK');
    }),
  );
});

describe('lastSyncIsFresh', () => {
  it('is false with no run at all', async () => {
    expect(await lastSyncIsFresh(db)).toBe(false);
  });

  it('is true for an applied run under 8 days old, a seed included', async () => {
    await run('applied', '7 days 23 hours');
    expect(await lastSyncIsFresh(db)).toBe(true);
    await admin.query('DELETE FROM museum_sync_run');
    await run('applied', '1 hour', 'seed');
    expect(await lastSyncIsFresh(db)).toBe(true);
  });

  it('is false past 8 days, and a refused, failed or unfinished run does not count', async () => {
    await run('applied', '8 days 1 hour');
    await run('refused', '1 hour');
    await run('failed', '2 hours');
    await admin.query(
      "INSERT INTO museum_sync_run (mode, started_at, finished_at, outcome) VALUES ('sync', now(), NULL, NULL)",
    );
    expect(await lastSyncIsFresh(db)).toBe(false);
  });
});

/** Mail is configured: MJK_MAIL_CAP is required for mail, and the ping fails without it. */
const CAP = { MJK_MAIL_CAP: '300' };

describe('pingWorkerHealth', () => {
  it('pings success while the sync is fresh', async () => {
    await run('applied', '2 days');
    const { logger, lines } = memoryLogger('worker');
    expect(await pingWorkerHealth(db, pinger(), logger, CAP)).toBe(true);
    expect(hits).toEqual(['mjk-worker']);
    expect(lines()).toEqual([]);
  });

  it('pings /fail when the sync is stale, and logs a fixed code', async () => {
    await run('applied', '9 days');
    const { logger, lines } = memoryLogger('worker');
    expect(await pingWorkerHealth(db, pinger(), logger, CAP)).toBe(true);
    expect(hits).toEqual(['mjk-worker/fail']);
    expect(lines().map((l) => l.msg)).toEqual(['sync_stale']);
  });

  it('pings /fail when the database cannot answer, with no message in the log', async () => {
    const broken = createDb(
      createPool('mjk_worker', { DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z' }, { max: 1 }) as pg.Pool,
    );
    const { logger, lines } = memoryLogger('worker');
    await pingWorkerHealth(broken, pinger(), logger, CAP);
    await broken.destroy();
    expect(hits).toEqual(['mjk-worker/fail']);
    expect(lines().map((l) => l.msg)).toEqual(['health_check_failed', 'sync_stale']);
    expect(JSON.stringify(lines())).not.toContain('127.0.0.1');
  });

  it('survives a hc-ping outage: the answer is false and nothing throws', async () => {
    await run('applied', '1 day');
    server.use(http.post('https://hc-ping.com/:key/:slug', () => HttpResponse.error()));
    expect(await pingWorkerHealth(db, pinger(), memoryLogger().logger, CAP)).toBe(false);
  });
});

describe('startHealthPing', () => {
  it('pings at once and then on the interval, and stops', async () => {
    await run('applied', '1 day');
    const timer = startHealthPing({ db, pinger: pinger(), logger: memoryLogger().logger, env: CAP, everyMs: 40 });
    await delay(300);
    timer.stop();
    const n = hits.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(new Set(hits)).toEqual(new Set(['mjk-worker']));
    await delay(150);
    expect(hits.length).toBe(n);
  });

  it('without a key it makes no query and no ping', async () => {
    const { logger, lines } = memoryLogger('worker');
    const none = createPinger({ logger, secretsDir: mkdtempSync(join(tmpdir(), 'mjk-hcp-')) });
    const timer = startHealthPing({ db: {} as Db, pinger: none, logger, everyMs: 10 });
    await delay(60);
    timer.stop();
    expect(hits).toEqual([]);
    expect(lines().map((l) => l.msg)).toEqual(['healthchecks_disabled']);
  });
});
