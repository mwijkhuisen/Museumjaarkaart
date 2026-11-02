import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorBody } from '@mjk/contracts';
import { http, passthrough } from 'msw';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { createApp } from '../../src/api/app.ts';
import { drain, listen } from '../../src/api/server.ts';
import { createDb } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { type Case, cases, openSweep, type Sweep, V1 } from './sweep.ts';

// The api over a real socket (review of PR #37): `app.request()` bypasses @hono/node-server, whose
// request object is not an undici Request (`overrideGlobalObjects: false`), so the adapter path needs
// its own proof. Every method on the admin path and on public routes, with no body, a small body,
// a body over the cap and a chunked body (a body of unknown length): the status, the fixed error
// body, `private, no-store` on every 4xx, no cookie, no CORS, and never a 500. Then the sweep's
// cases over the socket equal the in-process answers.

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;
type Method = (typeof METHODS)[number];
type BodyKind = 'none' | 'small' | 'large' | 'chunked';
const BODIES: readonly BodyKind[] = ['none', 'small', 'large', 'chunked'];

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

let s: Sweep;
let server: Server;
let port = 0;

beforeAll(async () => {
  s = await openSweep();
  server = await listen(s.app, 0, '127.0.0.1');
  port = (server.address() as AddressInfo).port;
}, 120_000);
afterAll(async () => {
  if (server !== undefined) await drain(server, 1_000);
  await s?.close();
});
// msw intercepts node:http and loopback too: let the requests to the listening server through.
beforeEach(() => {
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
});

/** One HTTP/1.1 request over its own connection, through node:http. */
function send(p: number, method: string, path: string, kind: BodyKind = 'none'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let body: Buffer | null = null;
    if (kind === 'small') body = Buffer.from('{"a":1}');
    if (kind === 'large') body = Buffer.alloc(70 * 1024, 0x61);
    if (body !== null) headers['Content-Length'] = String(body.length);
    if (kind === 'chunked') headers['Transfer-Encoding'] = 'chunked';
    const req = request({ host: '127.0.0.1', port: p, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    if (kind === 'chunked') {
      req.write('abc');
      req.write(Buffer.alloc(70 * 1024, 0x62));
    }
    req.end();
  });
}

const noLeaks = (a: Answer, label: string) => {
  expect(a.headers['set-cookie'], label).toBeUndefined();
  for (const name of Object.keys(a.headers))
    expect(name.startsWith('access-control-'), `${label}: ${name}`).toBe(false);
};

/** What the public route must answer to `method` with `kind`: status and error body (null for a 2xx). */
function expectedPublic(method: Method, kind: BodyKind): { status: number; error: ErrorBody | null } {
  if (kind === 'chunked') return { status: 400, error: { error: 'bad_request', fields: [] } };
  if (kind === 'large') return { status: 413, error: { error: 'too_large' } };
  if (method === 'GET' || method === 'HEAD') return { status: 200, error: null };
  return { status: 404, error: { error: 'not_found' } };
}

function checkAnswer(a: Answer, method: Method, status: number, error: ErrorBody | null, label: string) {
  expect(a.status, label).toBe(status);
  expect(a.status, label).not.toBe(500);
  noLeaks(a, label);
  if (status >= 400) {
    expect(a.headers['cache-control'], label).toBe('private, no-store');
    if (method !== 'HEAD') expect(ErrorBody.parse(JSON.parse(a.body)), label).toEqual(error);
  }
  if (method === 'HEAD') expect(a.body, label).toBe('');
}

describe('every method and body kind over a real socket', () => {
  it('/api/admin/* is a 404 whatever the method and body', async () => {
    for (const path of ['/api/admin/x', '/api/admin/users/1', '/api/admin/'])
      for (const method of METHODS)
        for (const kind of BODIES) {
          const label = `${method} ${path} ${kind}`;
          checkAnswer(await send(port, method, path, kind), method, 404, { error: 'not_found' }, label);
        }
  });

  it('a public route: GET and HEAD answer, other methods 404, a large body 413, a chunked body 400', async () => {
    const paths = [`${V1}/museums`, `${V1}/museums/${s.cat.named.kroller.slug}`, `${V1}/provinces`];
    for (const path of paths)
      for (const method of METHODS)
        for (const kind of BODIES) {
          const { status, error } = expectedPublic(method, kind);
          const label = `${method} ${path} ${kind}`;
          const a = await send(port, method, path, kind);
          checkAnswer(a, method, status, error, label);
          if (status === 200) expect(a.headers['cache-control'], label).toBe('public, max-age=0, s-maxage=60');
        }
  });

  it('an unknown method on a public path is a 404', async () => {
    for (const method of ['PROPFIND', 'TRACE'] as const) {
      const a = await send(port, method, `${V1}/museums`);
      expect(a.status, method).toBe(404);
      expect(a.headers['cache-control'], method).toBe('private, no-store');
      noLeaks(a, method);
    }
  });

  it('nothing above was logged as an internal error', () => {
    const errors = s.lines().filter((l) => l.msg !== 'request');
    expect(errors).toEqual([]);
  });
});

describe('the sweep over the socket equals the in-process answers', () => {
  let table: Case[];
  beforeAll(async () => {
    table = await cases(s);
  });

  it('status, Cache-Control, content type, Location and body', async () => {
    for (const row of table) {
      const inProcess = await s.req(row.path);
      const viaSocket = await send(port, 'GET', row.path);
      const label = row.name;
      expect(viaSocket.status, label).toBe(row.status);
      expect(viaSocket.status, label).toBe(inProcess.status);
      for (const h of ['cache-control', 'content-type', 'location'])
        expect(viaSocket.headers[h] ?? null, `${label} ${h}`).toBe(inProcess.headers.get(h));
      expect(viaSocket.body, label).toBe(await inProcess.text());
      noLeaks(viaSocket, label);
    }
  });
});

describe('a saturated pool', () => {
  it('answers 503 unavailable when no connection is free within the connect timeout', async () => {
    const pool = new pg.Pool({ connectionString: s.tdb.urls.mjk_api, max: 1, connectionTimeoutMillis: 200 });
    pool.on('error', () => {});
    const held = await pool.connect();
    const db = createDb(pool);
    const busy = await listen(createApp({ db, logger: silentLogger, ping: async () => true }), 0, '127.0.0.1');
    try {
      const a = await send((busy.address() as AddressInfo).port, 'GET', `${V1}/museums`);
      expect(a.status).toBe(503);
      expect(a.headers['cache-control']).toBe('private, no-store');
      expect(ErrorBody.parse(JSON.parse(a.body))).toEqual({ error: 'unavailable' });
    } finally {
      held.release();
      await drain(busy, 1_000);
      await db.destroy();
    }
  });
});
