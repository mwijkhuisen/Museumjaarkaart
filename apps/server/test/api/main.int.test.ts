import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Healthz } from '@mjk/contracts';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { run } from '../../src/main.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The real `api` role as mjk_api on a migrated database (WP3): healthz over HTTP, the heartbeat
// while the database answers, and the drain on the stop signal.

let db: TestDb;
beforeAll(async () => {
  db = await createMigratedDb();
});
afterAll(async () => {
  await db?.drop();
});

it('serves healthz as mjk_api, touches the heartbeat, and exits 0 after the stop signal', async () => {
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
  const hb = join(mkdtempSync(join(tmpdir(), 'mjk-api-')), 'hb');
  const stop = new AbortController();
  let port = 0;
  let listening: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const exited = run(['api'], { DATABASE_URL: db.urls.mjk_api, PATH: process.env.PATH }, () => {}, hb, {
    signal: stop.signal,
    port: 0,
    hostname: '127.0.0.1',
    onListening: (p) => {
      port = p;
      listening();
    },
  });
  await ready;

  const r = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(Healthz.parse(await r.json())).toEqual({ ok: true });
  expect(existsSync(hb)).toBe(true);

  stop.abort();
  expect(await exited).toBe(0);
  await expect(fetch(`http://127.0.0.1:${port}/api/v1/healthz`)).rejects.toThrow();
});
