import { webcrypto } from 'node:crypto';
import { sign } from 'hono/utils/jwt/jwt';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { type ApiDeps, buildApp } from '../../src/api/app.ts';
import {
  CERTS_FRESH_MS,
  CERTS_RETRY_MS,
  CERTS_STALE_MS,
  certsUrlOf,
  createJwksCache,
  isAdminHost,
  issuerOf,
} from '../../src/api/middleware/access-jwt.ts';
import type { Db } from '../../src/db/kysely.ts';
import { memoryLogger } from '../../src/lib/log.ts';

// The Cloudflare Access JWT on the admin host (A§9, ADR-0004, P1e WP5). msw serves the certs (CI
// never calls Cloudflare); Date is faked so `exp`, `nbf` and the certs cache share one clock.
// Every refusal must be the same 401, byte for byte apart from the request id.

const TEAM = 'test-team';
const AUD = 'a'.repeat(64);
const ISS = issuerOf(TEAM);
const CERTS = certsUrlOf(TEAM);
const ADMIN = 'admin.mjk.test';
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const nowS = () => Math.floor(Date.now() / 1000);

type KeyPair = {
  kid: string;
  publicJwk: webcrypto.JsonWebKey & { kid: string };
  privateJwk: webcrypto.JsonWebKey & { kid: string };
};

async function keyPair(kid: string): Promise<KeyPair> {
  const pair = (await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair;
  const publicJwk = { ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  const privateJwk = { ...(await webcrypto.subtle.exportKey('jwk', pair.privateKey)), kid };
  return { kid, publicJwk, privateJwk };
}

const K1 = await keyPair('kid-1');
const K2 = await keyPair('kid-2');
/** Same kid as K1, another key: a token it signs fails the signature check. */
const IMPOSTOR = await keyPair('kid-1');

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString('base64url');

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  email: 'owner@example.org',
  exp: nowS() + 600,
  iat: nowS(),
  nbf: nowS(),
  iss: ISS,
  sub: 'user-1',
  type: 'app',
  ...over,
});

const token = (key: KeyPair = K1, over: Record<string, unknown> = {}) => sign(claims(over), key.privateJwk);

/** A token with a header and signature of our own making (alg confusion, `none`). */
async function forged(header: Record<string, unknown>, payload: Record<string, unknown>, secret?: string) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (secret === undefined) return `${head}.`;
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `${head}.${b64url(new Uint8Array(await webcrypto.subtle.sign('HMAC', key, Buffer.from(head))))}`;
}

let served: { keys: unknown[] } | 'down' = { keys: [K1.publicJwk] };
let fetches = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  served = { keys: [K1.publicJwk] };
  fetches = 0;
  msw.use(
    http.get(CERTS, () => {
      fetches++;
      return served === 'down' ? new HttpResponse('down', { status: 500 }) : HttpResponse.json(served);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const { logger, lines } = memoryLogger('api');
  const deps: ApiDeps = {
    db: {} as Db,
    logger,
    ping: async () => true,
    access: {
      adminHost: ADMIN,
      issuer: ISS,
      audience: AUD,
      keys: createJwksCache({ url: CERTS, logger }),
    },
  };
  const app = buildApp(deps, (v1) => {
    v1.get('/who', (c) => c.json({ access: c.var.access ?? null }));
  });
  return { app, lines };
}

type App = ReturnType<typeof setup>['app'];

const call = (app: App, jwt: string | undefined, opts: { host?: string; path?: string; method?: string } = {}) =>
  app.request(`http://${ADMIN}${opts.path ?? '/api/v1/who'}`, {
    method: opts.method ?? 'GET',
    headers: { host: opts.host ?? ADMIN, ...(jwt === undefined ? {} : { 'Cf-Access-Jwt-Assertion': jwt }) },
  });

/** Status, every header but the request id, and the body: what must be identical for every refusal. */
async function shape(r: Response) {
  const headers = [...r.headers.entries()].filter(([name]) => name !== 'x-request-id');
  return { status: r.status, headers, body: await r.text() };
}

const REFUSAL = {
  status: 401,
  headers: [
    ['cache-control', 'private, no-store'],
    ['content-type', 'application/json'],
  ],
  body: '{"error":"unauthorized"}',
};

describe('isAdminHost', () => {
  it.each([
    ['admin.mjk.test', true],
    ['ADMIN.MJK.TEST', true],
    ['admin.mjk.test:443', true],
    ['Admin.Mjk.Test:8080', true],
    ['mjk.test', false],
    // Fail closed (P1e review S6): every form whose name part is the admin host is the admin host.
    ['admin.mjk.test.', true],
    ['ADMIN.MJK.TEST..', true],
    ['admin.mjk.test:', true],
    ['admin.mjk.test:x', true],
    ['admin.mjk.test:123456', true],
    ['admin.mjk.test.:443', true],
    ['admin.mjk.test:1:2', true],
    [`admin.mjk.test:${'9'.repeat(5000)}`, true],
    ['mjk.test:admin.mjk.test', false],
    ['admin.mjk.tes', false],
    ['xadmin.mjk.test', false],
    ['admin.mjk.test.evil.example', false],
    ['', false],
  ])('%j → %s', (host, expected) => {
    expect(isAdminHost(host, ADMIN)).toBe(expected);
  });
  it('no Host header is not the admin host', () => {
    expect(isAdminHost(undefined, ADMIN)).toBe(false);
  });
});

describe('a valid JWT on the admin host', () => {
  it('passes, sets the identity, and fetches the certs once', async () => {
    const { app, lines } = setup();
    const r = await call(app, await token());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ access: { email: 'owner@example.org' } });
    expect((await call(app, await token(), { host: 'ADMIN.mjk.test:443' })).status).toBe(200);
    expect(fetches).toBe(1);
    // Neither the email nor the token reaches a log line.
    expect(JSON.stringify(lines())).not.toContain('owner@example.org');
  });

  it('a single-string aud, a future iat (unchecked), an nbf inside the 60 s skew and no nbf all pass', async () => {
    const { app } = setup();
    for (const over of [{ aud: AUD }, { iat: nowS() + 3_600 }, { nbf: nowS() + 59 }, { nbf: undefined }])
      expect((await call(app, await token(K1, over))).status, JSON.stringify(over)).toBe(200);
  });

  it('a public host needs no JWT and sets no identity; /api/admin/* there is a 404 even with a valid JWT', async () => {
    const { app } = setup();
    const r = await call(app, undefined, { host: 'mjk.test' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ access: null });
    const admin = await call(app, await token(), { host: 'mjk.test', path: '/api/admin/users' });
    expect(admin.status).toBe(404);
    expect(await admin.text()).toBe('{"error":"not_found"}');
    expect(fetches).toBe(0);
  });

  it('on the admin host, /api/admin/* without a JWT is the 401; with one it is still a 404 until P2a', async () => {
    const { app } = setup();
    expect(await shape(await call(app, undefined, { path: '/api/admin/users', method: 'DELETE' }))).toEqual(REFUSAL);
    const r = await call(app, await token(), { path: '/api/admin/users' });
    expect(r.status).toBe(404);
  });
});

describe('every refusal is the same 401', () => {
  it('missing, malformed, bad signature, none, HS256, wrong iss, wrong aud, expired, no exp, future nbf, no email', async () => {
    const { app, lines } = setup();
    const valid = await token();
    const [head = '', body = ''] = valid.split('.');
    const cases: Record<string, string | undefined> = {
      missing: undefined,
      empty: '',
      garbage: 'not-a-jwt',
      'two parts': `${head}.${body}`,
      'four parts': `${valid}.x`,
      'bad base64 json': 'e30.bm90IGpzb24.c2ln',
      'bearer prefix': `Bearer ${valid}`,
      'too long': `${head}.${'A'.repeat(9_000)}.sig`,
      'bad signature': await token(IMPOSTOR),
      'tampered payload': `${head}.${b64url(JSON.stringify(claims({ email: 'evil@example.org' })))}.${valid.split('.')[2]}`,
      'alg none': await forged({ alg: 'none', kid: K1.kid, typ: 'JWT' }, claims()),
      'alg none with a signature': `${await forged({ alg: 'none', kid: K1.kid }, claims())}c2ln`,
      'alg HS256 keyed with the public key': await forged(
        { alg: 'HS256', kid: K1.kid, typ: 'JWT' },
        claims(),
        JSON.stringify(K1.publicJwk),
      ),
      'alg RS512': await forged({ alg: 'RS512', kid: K1.kid }, claims(), 'x'),
      'no kid': await forged({ alg: 'RS256' }, claims(), 'x'),
      'wrong iss': await token(K1, { iss: 'https://other-team.cloudflareaccess.com' }),
      'no iss': await token(K1, { iss: undefined }),
      'wrong aud': await token(K1, { aud: ['b'.repeat(64)] }),
      'no aud': await token(K1, { aud: undefined }),
      expired: await token(K1, { exp: nowS() - 1 }),
      'exp now': await token(K1, { exp: nowS() }),
      'absent exp': await token(K1, { exp: undefined }),
      'string exp': await token(K1, { exp: String(nowS() + 600) }),
      'future nbf': await token(K1, { nbf: nowS() + 61 }),
      'string nbf': await token(K1, { nbf: 'soon' }),
      'no email': await token(K1, { email: undefined }),
      'numeric email': await token(K1, { email: 42 }),
    };
    const shapes = [];
    for (const [name, jwt] of Object.entries(cases)) {
      const s = await shape(await call(app, jwt));
      expect(s, name).toEqual(REFUSAL);
      shapes.push(s);
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    // One code, a fixed reason, never a token, a claim or an email.
    const refusals = lines().filter((l) => l.msg !== 'request');
    expect(refusals.every((l) => l.msg === 'access_refused' && typeof l.reason === 'string')).toBe(true);
    expect(new Set(refusals.map((l) => l.reason))).toEqual(
      new Set(['missing', 'malformed', 'header', 'signature', 'iss', 'aud', 'exp', 'nbf', 'claims']),
    );
    const text = JSON.stringify(lines());
    for (const needle of ['evil@example.org', 'owner@example.org', head, 'other-team'])
      expect(text).not.toContain(needle);
  });

  it('the 401 is the same for every method and path on the admin host', async () => {
    const { app } = setup();
    for (const path of ['/api/v1/healthz', '/api/v1/auth/code', '/api/admin/x', '/nope'])
      for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS'])
        expect(await shape(await call(app, undefined, { path, method })), `${method} ${path}`).toEqual(REFUSAL);
  });
});

describe('the certs cache', () => {
  it('an unknown kid refetches once, then not again within CERTS_RETRY_MS; a rotated key then passes', async () => {
    const { app } = setup();
    expect((await call(app, await token(K1))).status).toBe(200);
    expect(fetches).toBe(1);
    // Right after a fetch an unknown kid fetches nothing: the same 401.
    expect(await shape(await call(app, await token(K2)))).toEqual(REFUSAL);
    expect(fetches).toBe(1);
    // K2 is not published yet: once the gap has passed, one refetch, then the same 401.
    vi.setSystemTime(T0 + CERTS_RETRY_MS + 1_000);
    expect(await shape(await call(app, await token(K2)))).toEqual(REFUSAL);
    expect(fetches).toBe(2);
    expect(await shape(await call(app, await token(K2)))).toEqual(REFUSAL);
    expect(await shape(await call(app, await token(K2, { exp: nowS() + 10 })))).toEqual(REFUSAL);
    expect(fetches).toBe(2);
    // Cloudflare publishes K2; after the retry gap the unknown kid refetches and passes.
    served = { keys: [K1.publicJwk, K2.publicJwk] };
    vi.setSystemTime(T0 + 2 * CERTS_RETRY_MS + 2_000);
    expect((await call(app, await token(K2))).status).toBe(200);
    expect(fetches).toBe(3);
    expect((await call(app, await token(K1))).status).toBe(200);
    expect(fetches).toBe(3);
  });

  it('concurrent first requests share one fetch', async () => {
    const { app } = setup();
    const jwt = await token();
    const answers = await Promise.all(Array.from({ length: 10 }, () => call(app, jwt)));
    expect(answers.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(fetches).toBe(1);
  });

  it('certs down with a fresh cache: the cache answers and nothing is fetched', async () => {
    const { app } = setup();
    expect((await call(app, await token())).status).toBe(200);
    served = 'down';
    vi.setSystemTime(T0 + CERTS_FRESH_MS - 1_000);
    expect((await call(app, await token())).status).toBe(200);
    expect(fetches).toBe(1);
  });

  it('certs down with a stale cache: used for up to an hour, refetched at most once per gap, then 503', async () => {
    const { app, lines } = setup();
    expect((await call(app, await token())).status).toBe(200);
    served = 'down';
    vi.setSystemTime(T0 + CERTS_FRESH_MS + 1_000);
    expect((await call(app, await token())).status).toBe(200);
    expect(fetches).toBe(2);
    expect((await call(app, await token())).status).toBe(200);
    expect(fetches).toBe(2);
    vi.setSystemTime(T0 + CERTS_STALE_MS - 1_000);
    expect((await call(app, await token())).status).toBe(200);
    expect(fetches).toBe(3);
    // A bad token is still a 401 while the stale keys serve.
    expect(await shape(await call(app, await token(IMPOSTOR)))).toEqual(REFUSAL);
    vi.setSystemTime(T0 + CERTS_STALE_MS + 1_000);
    const r = await call(app, await token());
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('{"error":"unavailable"}');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    // The last failed attempt was 2 s ago: no new fetch inside the gap.
    expect(fetches).toBe(3);
    const codes = lines().map((l) => l.msg);
    expect(codes).toContain('access_certs_fetch_failed');
    expect(codes).toContain('access_certs_unavailable');
    // Back up: the next allowed fetch restores the cache.
    served = { keys: [K1.publicJwk] };
    vi.setSystemTime(T0 + CERTS_STALE_MS + CERTS_RETRY_MS + 2_000);
    expect((await call(app, await token())).status).toBe(200);
  });

  it('certs down from the start: 503, and a missing JWT is still the 401', async () => {
    served = 'down';
    const { app } = setup();
    expect((await call(app, await token())).status).toBe(503);
    expect(await shape(await call(app, undefined))).toEqual(REFUSAL);
  });

  it.each([
    ['not JSON', () => new HttpResponse('<html>', { status: 200 })],
    ['no keys field', () => HttpResponse.json({ public_cert: 'x' })],
    [
      'only foreign keys',
      () => HttpResponse.json({ keys: [{ kty: 'EC', kid: 'kid-1', crv: 'P-256', x: 'a', y: 'b' }] }),
    ],
    ['an RS512 key', () => HttpResponse.json({ keys: [{ ...K1.publicJwk, alg: 'RS512' }] })],
    ['too large', () => HttpResponse.json({ keys: [K1.publicJwk], pad: 'x'.repeat(70 * 1024) })],
    ['a redirect', () => new HttpResponse(null, { status: 302, headers: { Location: 'https://evil.example/certs' } })],
  ])('a certs answer that is %s is a failed fetch (503 with no cache)', async (_name, answer) => {
    msw.use(http.get(CERTS, answer));
    const { app } = setup();
    expect((await call(app, await token())).status).toBe(503);
  });

  it('a JWK set with foreign keys next to ours keeps ours', async () => {
    served = { keys: [{ kty: 'EC', kid: 'ec', crv: 'P-256', x: 'a', y: 'b' }, K1.publicJwk] };
    const { app } = setup();
    expect((await call(app, await token())).status).toBe(200);
  });
});
