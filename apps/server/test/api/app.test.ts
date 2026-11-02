import { ErrorBody, Healthz } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiDeps, BODY_LIMIT_BYTES, buildApp, createApp } from '../../src/api/app.ts';
import { ApiError } from '../../src/api/errors.ts';
import { parseParam, parseQuery } from '../../src/api/query.ts';
import { sendJson } from '../../src/api/respond.ts';
import type { Db } from '../../src/db/kysely.ts';
import { memoryLogger } from '../../src/lib/log.ts';

// The api skeleton (WP3) without a database: the middleware order, the fixed errors, the headers
// and the request log. Routes that need PostgreSQL are tested in their own integration files.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Echo = z.strictObject({
  a: z.string().max(5).optional(),
  n: z
    .string()
    .regex(/^[0-9]$/)
    .optional(),
});

function setup(opts: { ping?: () => Promise<boolean> } = {}) {
  const { logger, lines } = memoryLogger('api');
  const deps: ApiDeps = { db: {} as Db, logger, ping: opts.ping ?? (async () => true) };
  const app = buildApp(deps, (v1) => {
    v1.get('/echo', (c) =>
      sendJson(c, z.strictObject({ a: z.string().nullable() }), { a: parseQuery(c, Echo).a ?? null }, 'x'),
    );
    // Registered before :slug, as the catalogue routes will be: the first registered route answers.
    v1.get('/museums/suggest', (c) => c.json({ which: 'suggest' }));
    v1.get('/museums/:slug', (c) => {
      parseParam('slug', c.req.param('slug'), z.string().regex(/^[a-z]+$/));
      return c.json({ which: 'slug' });
    });
    v1.get('/boom', () => {
      throw new Error('relation "secret_table" does not exist at value 52.123');
    });
    v1.get('/pg-down', () => {
      throw Object.assign(new Error('terminating connection'), { code: '57P01' });
    });
    v1.get('/mismatch', (c) => sendJson(c, z.strictObject({ ok: z.boolean() }), { ok: 'nope' } as never, 'x'));
    v1.get('/not-found', () => {
      throw new ApiError('not_found');
    });
    v1.post('/sink', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  });
  return { app, lines };
}

const get = (app: ReturnType<typeof setup>['app'], path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, init);

const json = async (r: Response) => JSON.parse(await r.text()) as unknown;

describe('healthz', () => {
  it('answers 200 {"ok":true} with no-store while the database answers', async () => {
    const { app } = setup();
    const r = await get(app, '/api/v1/healthz');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(Healthz.parse(await json(r))).toEqual({ ok: true });
  });

  it('answers 503 {"ok":false}, private, no-store when it does not', async () => {
    const { app } = setup({ ping: async () => false });
    const r = await get(app, '/api/v1/healthz');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(Healthz.parse(await json(r))).toEqual({ ok: false });
  });

  it('refuses any query parameter (strict)', async () => {
    const { app } = setup();
    const r = await get(app, '/api/v1/healthz?cachebust=1');
    expect(r.status).toBe(400);
    expect(ErrorBody.parse(await json(r))).toEqual({ error: 'bad_request', fields: [] });
  });

  it('createApp serves healthz too', async () => {
    const { logger } = memoryLogger('api');
    const app = createApp({ db: {} as Db, logger, ping: async () => true });
    expect((await app.request('http://localhost/api/v1/healthz')).status).toBe(200);
  });
});

describe('strict query parsing', () => {
  it.each([
    ['/api/v1/echo?zzz=1', []],
    ['/api/v1/echo?__proto__=1', []],
    ['/api/v1/echo?constructor=1', []],
    ['/api/v1/echo?a=toolong', ['a']],
    ['/api/v1/echo?a=x&a=y', ['a']],
    ['/api/v1/echo?zzz=1&zzz=2', []],
    ['/api/v1/echo?n=x&a=toolong', ['a', 'n']],
  ])('%s → 400 with fields %j, never a value or an unknown name', async (path, fields) => {
    const { app } = setup();
    const r = await get(app, path);
    expect(r.status).toBe(400);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = await r.text();
    expect(ErrorBody.parse(JSON.parse(body))).toEqual({ error: 'bad_request', fields });
    for (const leak of ['zzz', 'toolong', '__proto__', 'constructor']) expect(body).not.toContain(leak);
  });

  it('a known parameter once passes', async () => {
    const { app } = setup();
    const r = await get(app, '/api/v1/echo?a=hi');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ a: 'hi' });
  });

  it('a bad path parameter → 400 naming the parameter only', async () => {
    const { app } = setup();
    const r = await get(app, '/api/v1/museums/Bad_Slug');
    expect(r.status).toBe(400);
    expect(await json(r)).toEqual({ error: 'bad_request', fields: ['slug'] });
  });
});

describe('fixed errors', () => {
  it.each(['/api/v1/nope', '/api/v1/healthz/', '/nope', '/api/v2/healthz'])('%s → 404 not_found', async (path) => {
    const { app } = setup();
    const r = await get(app, path);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(ErrorBody.parse(await json(r))).toEqual({ error: 'not_found' });
  });

  it.each(['GET', 'POST', 'DELETE'])('/api/admin/* → 404 for %s (invariant 3)', async (method) => {
    const { app } = setup();
    for (const path of ['/api/admin/status', '/api/admin/', '/api/admin/museums/x?y=1']) {
      const r = await get(app, path, { method });
      expect(r.status, path).toBe(404);
      expect(await json(r)).toEqual({ error: 'not_found' });
    }
  });

  it('a route that throws → 500 internal; the log holds a fixed code, never the message', async () => {
    const { app, lines } = setup();
    const r = await get(app, '/api/v1/boom');
    expect(r.status).toBe(500);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal' });
    const log = JSON.stringify(lines());
    for (const leak of ['secret_table', '52.123', 'does not exist']) {
      expect(body).not.toContain(leak);
      expect(log).not.toContain(leak);
    }
    expect(lines().map((l) => l.msg)).toEqual(['internal_error', 'request']);
  });

  it('a database that went away → 503 unavailable, logged with its SQLSTATE only', async () => {
    const { app, lines } = setup();
    const r = await get(app, '/api/v1/pg-down');
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ error: 'unavailable' });
    expect(lines()[0]).toMatchObject({ msg: 'db_unavailable', sqlstate: '57P01' });
    expect(JSON.stringify(lines())).not.toContain('terminating');
  });

  it('an answer that fails its own contract → 500, logged as contract_mismatch', async () => {
    const { app, lines } = setup();
    const r = await get(app, '/api/v1/mismatch');
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ error: 'internal' });
    expect(lines()[0]?.msg).toBe('contract_mismatch');
  });

  it('an ApiError thrown by a route → its code', async () => {
    const { app } = setup();
    const r = await get(app, '/api/v1/not-found');
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ error: 'not_found' });
  });
});

describe('the 64 KB body cap', () => {
  it('passes 64 KB and refuses one byte more, with and without Content-Length', async () => {
    const { app } = setup();
    const ok = await get(app, '/api/v1/sink', { method: 'POST', body: new Uint8Array(BODY_LIMIT_BYTES) });
    expect(ok.status).toBe(200);
    const big = await get(app, '/api/v1/sink', { method: 'POST', body: new Uint8Array(BODY_LIMIT_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(big.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(big)).toEqual({ error: 'too_large' });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(BODY_LIMIT_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    const chunked = await get(app, '/api/v1/sink', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
  });
});

describe('headers', () => {
  it('every answer has our own request id, no CORS header and no Set-Cookie', async () => {
    const { app } = setup();
    const paths = [
      '/api/v1/healthz',
      '/api/v1/echo?a=1',
      '/api/v1/echo?b=1',
      '/api/v1/nope',
      '/api/admin/x',
      '/api/v1/boom',
    ];
    for (const path of paths) {
      const r = await get(app, path, { headers: { 'X-Request-Id': 'injected', Origin: 'https://evil.example' } });
      expect(r.headers.get('x-request-id'), path).toMatch(UUID);
      expect(r.headers.get('set-cookie'), path).toBeNull();
      for (const [name] of r.headers) expect(name.startsWith('access-control-'), `${path} ${name}`).toBe(false);
    }
  });
});

describe('the request log (invariant 8)', () => {
  it('one line per request: method, route pattern, status, duration and id; never the path or query', async () => {
    const { app, lines } = setup();
    const r = await get(app, '/api/v1/museums/rijksmuseum?lat=52.123&lon=4.567', {
      headers: { 'User-Agent': 'agent-secret', Cookie: 'sid=cookie-secret' },
    });
    expect(r.status).toBe(200);
    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'level',
      'method',
      'ms',
      'msg',
      'req',
      'role',
      'route',
      'status',
      'time',
    ]);
    expect(line).toMatchObject({
      msg: 'request',
      role: 'api',
      method: 'GET',
      route: '/api/v1/museums/:slug',
      status: 200,
      req: r.headers.get('x-request-id'),
    });
    expect(typeof line?.ms).toBe('number');
    const text = JSON.stringify(lines());
    for (const leak of ['rijksmuseum', '52.123', '4.567', 'agent-secret', 'cookie-secret'])
      expect(text).not.toContain(leak);
  });

  it('names the route that answers: suggest before :slug', async () => {
    const { app, lines } = setup();
    expect(await json(await get(app, '/api/v1/museums/suggest'))).toEqual({ which: 'suggest' });
    expect(lines()[0]?.route).toBe('/api/v1/museums/suggest');
  });

  it.each([
    ['/api/v1/nope/secret-path', 'GET', 'unmatched', 404],
    ['/api/admin/secret-path', 'GET', '/api/admin/*', 404],
    ['/api/v1/healthz', 'PROPFIND', 'unmatched', 404],
  ])('%s %s logs route %s', async (path, method, route, status) => {
    const { app, lines } = setup();
    expect((await get(app, path, { method })).status).toBe(status);
    expect(lines()[0]).toMatchObject({ route, status, method: method === 'PROPFIND' ? 'other' : method });
    expect(JSON.stringify(lines())).not.toContain('secret-path');
  });
});
