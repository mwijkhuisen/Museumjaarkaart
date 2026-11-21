import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { runSsr, type SsrRunOpts } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The real `ssr` role as mjk_ssr (WP2): the exit-78 config cases, a start on a free port with the
// real bundle, the heartbeat, and the drain on the stop signal.

let db: TestDb;
beforeAll(async () => {
  db = await createMigratedDb();
});
afterAll(async () => {
  await db?.drop();
});

const GOOD = () => ({
  MJK_BRAND_NAME: 'Musea Test',
  MJK_DOMAIN: 'mjk.test',
  DATABASE_URL: db.urls.mjk_ssr,
  PATH: process.env.PATH,
});

function opts(over: Partial<SsrRunOpts> = {}) {
  const lines: string[] = [];
  const { logger } = memoryLogger('ssr');
  const o: SsrRunOpts = {
    logger,
    signal: new AbortController().signal,
    heartbeatPath: join(mkdtempSync(join(tmpdir(), 'mjk-ssr-')), 'hb'),
    log: (l) => lines.push(l),
    port: 0,
    hostname: '127.0.0.1',
    ...over,
  };
  return { o, lines };
}

it.each([
  ['no MJK_BRAND_NAME', { MJK_BRAND_NAME: undefined }, 'ssr: MJK_BRAND_NAME is missing'],
  ['a bad MJK_DOMAIN', { MJK_DOMAIN: 'Evil Domain' }, 'ssr: MJK_DOMAIN must be a lowercase host name with a dot'],
])('exits 78 for %s and names the variable', async (_n, over, line) => {
  const { o, lines } = opts();
  expect(await runSsr({ ...GOOD(), ...over }, o)).toBe(78);
  expect(lines).toEqual([line]);
});

it('exits 78 for a DATABASE_URL that is not postgres, without echoing it', async () => {
  const { o, lines } = opts();
  expect(await runSsr({ ...GOOD(), DATABASE_URL: 'http://user:hunter2@example.test/db' }, o)).toBe(78);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ssr: /);
  expect(lines[0]).not.toContain('hunter2');
});

it('exits 78 when the web build is missing', async () => {
  const { o, lines } = opts({ bundleUrl: new URL('file:///nonexistent/entry-server.js') });
  expect(await runSsr(GOOD(), o)).toBe(78);
  expect(lines).toEqual(['ssr: the web build is missing']);
});

it('serves the home page as mjk_ssr, touches the heartbeat, and exits 0 after the stop signal', async () => {
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
  const stop = new AbortController();
  let port = 0;
  let listening: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const { o } = opts({
    signal: stop.signal,
    onListening: (p) => {
      port = p;
      listening();
    },
  });
  const exited = runSsr(GOOD(), o);
  await ready;

  const r = await fetch(`http://127.0.0.1:${port}/`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await r.text()).toMatch(/^<!doctype html>/);
  expect(existsSync(o.heartbeatPath)).toBe(true);

  stop.abort();
  expect(await exited).toBe(0);
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});
