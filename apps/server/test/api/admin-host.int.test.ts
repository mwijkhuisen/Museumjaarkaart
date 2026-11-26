import { webcrypto } from 'node:crypto';
import { AdminMe, ErrorBody } from '@mjk/contracts';
import { sign } from 'hono/utils/jwt/jwt';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { type ApiDeps, createApp } from '../../src/api/app.ts';
import { certsUrlOf, createJwksCache, issuerOf } from '../../src/api/middleware/access-jwt.ts';
import { SESSION_COOKIE, startSession } from '../../src/auth/session.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { makeTestKeys } from '../auth/test-keys.ts';

// Criteria 12 and 13 (D22, ADR-0004, A§9, A§14) on createApp as the api serves it: on the admin host
// every route, the auth routes included, needs a valid Access JWT first (one identical 401 over the
// bad-JWT matrix); sign-up and uploads do not exist there; `/api/admin/*` also needs an admin-host
// session of the JWT's email and the role moderator or admin. msw serves the certs (CI never calls
// Cloudflare).

const TEAM = 'test-team';
const AUD = 'a'.repeat(64);
const ISS = issuerOf(TEAM);
const CERTS = certsUrlOf(TEAM);
const ADMIN = 'admin.mjk.test';
const nowS = () => Math.floor(Date.now() / 1000);

async function keyPair(kid: string) {
  const pair = (await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair;
  return {
    publicJwk: { ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid },
    privateJwk: { ...(await webcrypto.subtle.exportKey('jwk', pair.privateKey)), kid },
  };
}
const K1 = await keyPair('kid-1');
const UNKNOWN = await keyPair('kid-unknown');
const b64url = (d: string | Uint8Array) => Buffer.from(d).toString('base64url');

const jwt = (email: string, over: Record<string, unknown> = {}, key = K1) =>
  sign({ aud: [AUD], email, exp: nowS() + 600, iat: nowS(), nbf: nowS(), iss: ISS, sub: 's', ...over }, key.privateJwk);
async function forged(header: Record<string, unknown>, secret?: string) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify({ aud: [AUD], iss: ISS, email: 'x@example.org', exp: nowS() + 600 }))}`;
  if (secret === undefined) return `${head}.`;
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `${head}.${b64url(new Uint8Array(await webcrypto.subtle.sign('HMAC', key, Buffer.from(head))))}`;
}

let a: AuthDb;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  a = await openAuthDb();
  const { logger } = memoryLogger('api');
  const deps: ApiDeps = {
    db: a.db,
    logger,
    ping: async () => true,
    keys: makeTestKeys(),
    site: { domain: 'mjk.test', adminHost: ADMIN },
    clientAddress: { peer: () => '192.0.2.10' },
    access: { adminHost: ADMIN, issuer: ISS, audience: AUD, keys: createJwksCache({ url: CERTS, logger }) },
  };
  app = createApp(deps);
}, 120_000);
afterAll(async () => {
  await a?.close();
});
beforeEach(() => {
  msw.use(http.get(CERTS, () => HttpResponse.json({ keys: [K1.publicJwk] })));
});

const call = (
  path: string,
  o: { host?: string; jwt?: string; cookie?: string; method?: string; body?: unknown } = {},
) => {
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  return app.request(`http://${o.host ?? ADMIN}${path}`, {
    method: o.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      host: o.host ?? ADMIN,
      'sec-fetch-site': 'same-origin',
      ...(o.jwt === undefined ? {} : { 'cf-access-jwt-assertion': o.jwt }),
      ...(o.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${o.cookie}` }),
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
    },
    ...(body === undefined ? {} : { body }),
  });
};

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/v1/me'],
  ['GET', '/api/v1/me/sessions'],
  ['GET', '/api/v1/auth/altcha'],
  ['POST', '/api/v1/auth/code', { email: 'owner@example.org', purpose: 'signin', altcha: 'x', locale: 'nl' }],
  ['POST', '/api/v1/auth/code/verify', { email: 'owner@example.org', purpose: 'signin', code: '123456' }],
  ['POST', '/api/v1/auth/password', { email: 'owner@example.org', password: 'correct horse battery' }],
  ['POST', '/api/v1/auth/signout'],
  ['POST', '/api/v1/auth/signup', {}],
  ['GET', '/api/v1/museums'],
  ['GET', '/api/v1/healthz'],
];

describe('the admin host: the Access JWT first, on every route', () => {
  it.each(ROUTES)('%s %s without a JWT → 401', async (method, path, body) => {
    const r = await call(path, { method, body });
    expect(r.status).toBe(401);
    expect(ErrorBody.parse(await r.json())).toEqual({ error: 'unauthorized' });
  });

  it('every bad JWT gets the same 401, on the auth routes and the admin routes alike', async () => {
    const bad = [
      await jwt('owner@example.org', { aud: ['b'.repeat(64)] }),
      await jwt('owner@example.org', { iss: 'https://evil.cloudflareaccess.com' }),
      await jwt('owner@example.org', { exp: nowS() - 120 }),
      await jwt('owner@example.org', { exp: undefined }),
      await jwt('owner@example.org', {}, UNKNOWN),
      await forged({ alg: 'HS256', typ: 'JWT', kid: 'kid-1' }, 'secret'),
      await forged({ alg: 'none', typ: 'JWT' }),
      'not.a.jwt',
    ];
    for (const [method, path, body] of [ROUTES[0], ROUTES[6]] as Array<[string, string, unknown?]>) {
      const texts = new Set<string>();
      for (const token of bad) {
        const r = await call(path, { method, body, jwt: token });
        expect(r.status, `${path} ${token.slice(0, 20)}`).toBe(401);
        texts.add(await r.text());
      }
      expect(texts.size).toBe(1);
    }
  });

  it('sign-up and uploads do not exist there, even with a valid JWT', async () => {
    const token = await jwt('owner@example.org');
    for (const [method, path] of [
      ['POST', '/api/v1/auth/signup'],
      ['GET', '/api/v1/uploads'],
      ['POST', '/api/v1/uploads'],
      ['PUT', '/api/v1/uploads/x/chunks/0'],
    ] as const) {
      const r = await call(path, {
        method,
        jwt: token,
        ...(method === 'POST' && path.endsWith('signup') ? { body: {} } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('/api/admin/*: an admin-host session of the JWT’s email, and the role', () => {
  const session = async (userId: string, host: 'public' | 'admin' = 'admin') =>
    (await startSession(a.db, { userId, host, method: 'code', sentToken: null })).token;

  it('admin → 200; moderator → 200', async () => {
    for (const role of ['admin', 'moderator'] as const) {
      const u = await a.newUser({ role });
      const r = await call('/api/admin/me', { jwt: await jwt(u.email), cookie: await session(u.id) });
      expect(r.status, role).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(AdminMe.parse(await r.json())).toEqual({ handle: u.handle, role });
    }
  });

  it('role user → 403; no session → 401', async () => {
    const u = await a.newUser({ role: 'user' });
    expect((await call('/api/admin/me', { jwt: await jwt(u.email), cookie: await session(u.id) })).status).toBe(403);
    expect((await call('/api/admin/me', { jwt: await jwt(u.email) })).status).toBe(401);
  });

  it('a JWT for another email → 403 (the email must match, D22)', async () => {
    const u = await a.newUser({ role: 'admin' });
    const r = await call('/api/admin/me', { jwt: await jwt('someone.else@example.org'), cookie: await session(u.id) });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden' });
  });

  it('the JWT’s email in another case still matches', async () => {
    const u = await a.newUser({ role: 'admin' });
    const r = await call('/api/admin/me', { jwt: await jwt(u.email.toUpperCase()), cookie: await session(u.id) });
    expect(r.status).toBe(200);
  });

  it('a public-host session cookie never works on the admin host', async () => {
    const u = await a.newUser({ role: 'admin' });
    const r = await call('/api/admin/me', { jwt: await jwt(u.email), cookie: await session(u.id, 'public') });
    expect(r.status).toBe(401);
    expect((await call('/api/v1/me', { jwt: await jwt(u.email), cookie: await session(u.id, 'public') })).status).toBe(
      200,
    );
    const me = await (
      await call('/api/v1/me', { jwt: await jwt(u.email), cookie: await session(u.id, 'public') })
    ).json();
    expect(me).toEqual({ user: null });
  });

  it('/api/admin/* on the public host is a 404, with or without a JWT and a session', async () => {
    const u = await a.newUser({ role: 'admin' });
    for (const o of [{}, { jwt: await jwt(u.email), cookie: await session(u.id, 'public') }]) {
      const r = await call('/api/admin/me', { host: 'mjk.test', ...o });
      expect(r.status).toBe(404);
    }
  });
});
