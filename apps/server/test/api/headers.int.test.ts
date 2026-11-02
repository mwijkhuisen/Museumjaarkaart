import { ErrorBody } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { type Case, cases, openSweep, report, type Sweep, UUID_RE, V1 } from './sweep.ts';

// P1b criterion 4 (headers) and invariant 8 (the request log): Cache-Control per route and status, no cookie,
// no CORS, our own request id, JSON content type, no admin route on this host, and a log without values.

let s: Sweep;
let table: Case[];
let started = 0;
const extra: Db[] = [];

beforeAll(async () => {
  s = await openSweep();
  table = await cases(s);
  started = performance.now();
}, 120_000);
afterAll(async () => {
  if (s !== undefined) report('headers', s, started);
  for (const d of extra) await d.destroy();
  await s?.close();
});

const noLeaks = (r: Response, label: string) => {
  expect(r.headers.get('set-cookie'), label).toBeNull();
  for (const [name] of r.headers)
    expect(name.toLowerCase().startsWith('access-control-'), `${label}: ${name}`).toBe(false);
};

describe('headers per route and status', () => {
  it('Cache-Control, content type, request id, no cookie and no CORS, with and without an Origin', async () => {
    for (const row of table) {
      for (const init of [
        undefined,
        { headers: { Origin: 'https://evil.example', 'X-Request-Id': 'client-chosen' } },
      ]) {
        const r = await s.req(row.path, init);
        const label = `${row.name} ${init === undefined ? '' : 'with Origin'}`;
        expect(r.status, label).toBe(row.status);
        expect(r.headers.get('cache-control'), label).toBe(row.cache);
        noLeaks(r, label);
        const id = r.headers.get('x-request-id');
        expect(id, label).toMatch(UUID_RE);
        expect(id, label).not.toBe('client-chosen');
        if (row.status !== 301) expect(r.headers.get('content-type'), label).toMatch(/^application\/json/);
        await r.arrayBuffer();
      }
    }
  });

  it('a request id differs between two requests, and a client uuid is never taken over', async () => {
    const mine = '11111111-2222-4333-8444-555555555555';
    const a = await s.req(`${V1}/provinces`, { headers: { 'X-Request-Id': mine } });
    const b = await s.req(`${V1}/provinces`, { headers: { 'X-Request-Id': mine } });
    expect(a.headers.get('x-request-id')).toMatch(UUID_RE);
    expect(a.headers.get('x-request-id')).not.toBe(mine);
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));
  });

  it('/api/admin/* is a 404 on this host, whatever the method', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/api/admin/anything', '/api/admin/', '/api/admin/users/1']) {
        const r = await s.req(path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'x' } });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.headers.get('cache-control')).toBe('private, no-store');
        expect(ErrorBody.parse(await r.json())).toEqual({ error: 'not_found' });
        noLeaks(r, path);
      }
    }
  });

  it('an unsafe method on a public route is a private, no-store 4xx', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await s.req(`${V1}/museums`, { method });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      noLeaks(r, method);
      await r.arrayBuffer();
    }
    const big = await s.req(`${V1}/museums`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
    expect(big.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await big.json())).toEqual({ error: 'too_large' });
  });

  it('healthz is 503 and private, no-store when the database does not answer', async () => {
    const { logger } = memoryLogger('api');
    const down = createApp({ db: s.db, logger, ping: async () => false });
    const r = await down.request('http://localhost/api/v1/healthz');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.json()).toEqual({ ok: false });
    noLeaks(r, 'healthz 503');
  });

  it('a 500 and a 503 are private, no-store, fixed bodies that carry no database text', async () => {
    const MARK = 'zzdbtext';
    const broken = new Proxy(
      {},
      {
        get() {
          throw new Error(`boom ${MARK}`);
        },
      },
    ) as unknown as Db;
    const { logger, lines } = memoryLogger('api');
    const app500 = createApp({ db: broken, logger, ping: async () => true });
    for (const path of [
      `${V1}/museums`,
      `${V1}/museums/suggest?q=a`,
      `${V1}/museums/near?lat=52.100&lon=5.100`,
      `${V1}/provinces`,
      `${V1}/mk-list`,
      `${V1}/museums/some-slug`,
    ]) {
      const r = await app500.request(`http://localhost${path}`);
      expect(r.status, path).toBe(500);
      expect(r.headers.get('cache-control'), path).toBe('private, no-store');
      expect(r.headers.get('x-request-id'), path).toMatch(UUID_RE);
      noLeaks(r, path);
      const text = await r.text();
      expect(text).not.toContain(MARK);
      expect(ErrorBody.parse(JSON.parse(text))).toEqual({ error: 'internal' });
    }
    expect(JSON.stringify(lines())).not.toContain(MARK);

    // A pool that cannot connect: the database is unavailable.
    const u = new URL(s.tdb.urls.mjk_api);
    u.port = '1';
    const pool = createPool('mjk_api', { DATABASE_URL: u.href }, { max: 1 });
    if (typeof pool === 'string') throw new Error(pool);
    const dead = createDb(pool);
    extra.push(dead);
    const app503 = createApp({ db: dead, logger: memoryLogger('api').logger, ping: async () => false });
    const r = await app503.request('http://localhost/api/v1/museums');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await r.json())).toEqual({ error: 'unavailable' });
    noLeaks(r, '503');
  });
});

describe('the request log', () => {
  it('holds one line per request with the route pattern and no value', async () => {
    const { logger, lines } = memoryLogger('api');
    const app = createApp({ db: s.db, logger, ping: async () => true });
    const slug = 'zzslugmark-a';
    const cursor = 'zzcursormark';
    const asked: Array<{ path: string; route: string; status: number }> = [
      { path: `${V1}/museums/${slug}`, route: `${V1}/museums/:slug`, status: 404 },
      { path: `${V1}/museums/${s.cat.named.kroller.slug}`, route: `${V1}/museums/:slug`, status: 200 },
      { path: `${V1}/museums/${s.cat.named.renamed.oldSlugs[0]}`, route: `${V1}/museums/:slug`, status: 301 },
      { path: `${V1}/museums?q=zzqmarkrijks`, route: `${V1}/museums`, status: 200 },
      { path: `${V1}/museums?cursor=${cursor}`, route: `${V1}/museums`, status: 400 },
      { path: `${V1}/museums/suggest?q=zzqmarksuggest`, route: `${V1}/museums/suggest`, status: 200 },
      { path: `${V1}/museums/near?lat=52.123&lon=4.567`, route: `${V1}/museums/near`, status: 200 },
      { path: `${V1}/museums/near?lat=52.1234&lon=4.5678`, route: `${V1}/museums/near`, status: 400 },
      { path: `${V1}/museums?zzunknownmark=zzvaluemark`, route: `${V1}/museums`, status: 400 },
      { path: `${V1}/provinces`, route: `${V1}/provinces`, status: 200 },
      { path: `${V1}/mk-list`, route: `${V1}/mk-list`, status: 200 },
      { path: `${V1}/healthz`, route: `${V1}/healthz`, status: 200 },
      { path: '/api/admin/zzadminmark', route: '/api/admin/*', status: 404 },
      { path: `${V1}/zzunmatchedmark`, route: 'unmatched', status: 404 },
    ];
    for (const a of asked) {
      const r = await app.request(`http://localhost${a.path}`, { headers: { Origin: 'https://zzoriginmark.example' } });
      expect(r.status, a.path).toBe(a.status);
      await r.arrayBuffer();
    }
    const log = lines();
    expect(log.length).toBe(asked.length);
    expect(log.map((l) => l.route)).toEqual(asked.map((a) => a.route));
    expect(log.map((l) => l.status)).toEqual(asked.map((a) => a.status));
    for (const l of log)
      expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['req', 'method', 'route', 'status', 'ms']));
    expect(new Set(log.map((l) => l.req)).size).toBe(asked.length);
    const text = JSON.stringify(log);
    for (const leak of [
      slug,
      'zzslugmark',
      cursor,
      'zzqmark',
      'zzunknownmark',
      'zzvaluemark',
      'zzadminmark',
      'zzunmatchedmark',
      'zzoriginmark',
      '52.12',
      '4.56',
      s.cat.named.kroller.slug,
      s.cat.named.renamed.oldSlugs[0],
    ])
      expect(text, leak).not.toContain(leak);
  });
});
