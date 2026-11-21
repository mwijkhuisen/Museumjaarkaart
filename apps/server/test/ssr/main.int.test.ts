import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { runSsr, type SsrRunOpts } from '../../src/ssr/server.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The real `ssr` role as mjk_ssr (WP2): the exit-78 config cases, a start on a free port with the
// real bundle, the heartbeat, and the drain on the stop signal.

const BUNDLE = new URL('../../../web/dist/server/entry-server.js', import.meta.url);

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
  MJK_CONTROLLER_NAME: 'Test Beheerder',
  MJK_CONTACT_EMAIL: 'info@mjk.test',
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
  ['no MJK_CONTROLLER_NAME', { MJK_CONTROLLER_NAME: undefined }, 'ssr: MJK_CONTROLLER_NAME is missing'],
  ['a bad MJK_CONTACT_EMAIL', { MJK_CONTACT_EMAIL: 'a b' }, 'ssr: MJK_CONTACT_EMAIL must be an email address'],
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

// The real SSR bundle (self-contained: noExternal) copied next to a client manifest that is absent
// or wrong: the bundle reads it when it loads, so `ssr` exits 78 before it serves.
function copiedBuild(manifest: object | null): URL {
  const dir = mkdtempSync(join(tmpdir(), 'mjk-broken-'));
  mkdirSync(join(dir, 'server'));
  copyFileSync(fileURLToPath(BUNDLE), join(dir, 'server', 'entry-server.js'));
  if (manifest !== null) {
    mkdirSync(join(dir, 'client', '.vite'), { recursive: true });
    writeFileSync(join(dir, 'client', '.vite', 'manifest.json'), JSON.stringify(manifest));
  }
  return pathToFileURL(join(dir, 'server', 'entry-server.js'));
}

it('loads a copy of the build with its own manifest (the control for the cases below)', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../client/.vite/manifest.json', BUNDLE), 'utf8')) as object;
  expect(typeof (await loadBundle(copiedBuild(manifest)))).toBe('object');
});

it.each<[string, object | null]>([
  ['no manifest', null],
  ['an entry without CSS', { 'src/entry-client.tsx': { file: 'assets/entry-client-x.js' } }],
  ['a path outside /assets', { 'src/entry-client.tsx': { file: '../evil.js', css: ['assets/x.css'] } }],
])('exits 78 when the web build is broken: %s', async (_n, manifest) => {
  const { o, lines } = opts({ bundleUrl: copiedBuild(manifest) });
  expect(await runSsr(GOOD(), o)).toBe(78);
  expect(lines).toEqual(['ssr: the web build is broken']);
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
