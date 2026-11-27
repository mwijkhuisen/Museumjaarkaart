import { createHash } from 'node:crypto';
import { Me } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.ts';
import { mountPassword, type PasswordDeps } from '../../src/api/routes/password.ts';
import { ARGON2_PARAMS, createHashGate, hashGate, hashPassword, needsRehash } from '../../src/auth/argon2.ts';
import { SESSION_COOKIE, startSession } from '../../src/auth/session.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';
import { makeTestKeys } from './test-keys.ts';

// POST /auth/password, PUT and DELETE /me/password (A§9, A§14, A§16.2; P2a criteria 10 and 11).
// Each request comes from its own /24 unless a test names one (`x-test-peer`, read only by this
// file's peer function), so the per-prefix limit never couples two tests. The Access identity on
// the admin host comes from `x-test-access`, set by a test middleware in place of accessJwt.

let a: AuthDb;
const { logger, lines } = memoryLogger('api');
/** Everything that must never reach a log line. */
const secrets: string[] = [];

let n = 0;
const nextPeer = () => {
  n += 1;
  return `11.${(n >> 8) & 255}.${n & 255}.7`;
};

function makeApp(extra: Partial<PasswordDeps> = {}) {
  return buildApp(
    {
      db: a.db,
      logger,
      ping: async () => true,
      keys: makeTestKeys(),
      site: { domain: 'mjk.test', adminHost: 'admin.mjk.test' },
      clientAddress: {
        peer: (c) => {
          const p = c.req.header('x-test-peer');
          return p === 'none' ? undefined : (p ?? nextPeer());
        },
      },
    },
    (v1, d) => {
      v1.use('*', async (c, next) => {
        const email = c.req.header('x-test-access');
        if (email !== undefined) c.set('access', { email });
        await next();
      });
      mountPassword(v1, { ...d, ...extra });
    },
  );
}

let app: ReturnType<typeof makeApp>;

type Opts = { method?: string; path?: string; peer?: string; host?: string; cookie?: string; access?: string };

const call = (body: unknown, o: Opts = {}) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return app.request(`http://localhost/api/v1${o.path ?? '/auth/password'}`, {
    method: o.method ?? 'POST',
    headers: {
      host: o.host ?? 'mjk.test',
      'Sec-Fetch-Site': 'same-origin',
      ...(text === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) }),
      ...(o.peer ? { 'x-test-peer': o.peer } : {}),
      ...(o.cookie ? { cookie: `${SESSION_COOKIE}=${o.cookie}` } : {}),
      ...(o.access ? { 'x-test-access': o.access } : {}),
    },
    ...(text === undefined ? {} : { body: text }),
  });
};

const signIn = (email: string, password: string, o: Opts = {}) => {
  secrets.push(email, password);
  return call({ email, password }, o);
};

const tokenOf = (res: Response): string => {
  const m = /^__Host-mjk_sid=([A-Za-z0-9_-]{43});/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie');
  secrets.push(m[1] as string, res.headers.get('set-cookie') as string);
  return m[1] as string;
};

const idOf = (token: string) => createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
const sessionsOf = async (userId: string) =>
  (await a.admin.query<{ id: Buffer; host: string }>('SELECT id, host FROM session WHERE user_id = $1', [userId])).rows;
const hashOf = async (userId: string) =>
  (await a.admin.query<{ h: string | null }>('SELECT password_hash AS h FROM app_user WHERE id = $1', [userId])).rows[0]
    ?.h;

const PW = 'correct horse battery';
let pwHash: string;

/** A member with the shared password (or the given hash). */
const member = (opts: Parameters<AuthDb['newUser']>[0] = {}) => a.newUser({ password_hash: pwHash, ...opts });

/** A gate that counts its runs, around a fresh real one. */
const countingGate = () => {
  const inner = createHashGate();
  const g = {
    runs: 0,
    run<T>(fn: () => Promise<T>) {
      g.runs += 1;
      return inner.run(fn);
    },
    inFlight: 0,
    maxInFlight: 0,
  };
  return g;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return ((s[(s.length - 1) >> 1] as number) + (s[s.length >> 1] as number)) / 2;
};

beforeAll(async () => {
  a = await openAuthDb();
  app = makeApp();
  pwHash = await hashPassword(PW);
  secrets.push(PW, pwHash);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('POST /auth/password: criterion 10', () => {
  it('a password of 11 or 257 characters is a 400', async () => {
    const u = await member();
    for (const pw of ['x'.repeat(11), 'x'.repeat(257)]) {
      const r = await signIn(u.email, pw);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'bad_request', fields: ['password'] });
    }
  });

  it('stores an argon2id PHC string at or above OWASP’s floor', async () => {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.exec(pwHash);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(19_456);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(2);
    expect(Number(m?.[3])).toBeGreaterThanOrEqual(1);
  });

  it('an unknown email, an account without a password and a wrong password: one answer, one timing', async () => {
    const TRIES = 8;
    const times: Record<'unknown' | 'nopassword' | 'wrong', number[]> = { unknown: [], nopassword: [], wrong: [] };
    const answers = new Set<string>();
    for (let i = 0; i < TRIES; i++) {
      // Fresh accounts and emails each round: the per-email limit (5 per 15 min) never interferes.
      const noPw = await a.newUser();
      const withPw = await member();
      const cases = {
        unknown: () => signIn(`nobody${i}.${process.pid}@example.org`, PW),
        nopassword: () => signIn(noPw.email, PW),
        wrong: () => signIn(withPw.email, `${PW}!`),
      } as const;
      for (const [name, run] of Object.entries(cases) as [keyof typeof cases, () => Promise<Response>][]) {
        const t0 = performance.now();
        const r = await run();
        const body = await r.text();
        times[name].push(performance.now() - t0);
        const headers = [...r.headers].filter(([k]) => k !== 'x-request-id');
        answers.add(JSON.stringify([r.status, body, headers]));
      }
    }
    expect([...answers]).toEqual([
      JSON.stringify([
        401,
        '{"error":"unauthorized"}',
        [
          ['cache-control', 'private, no-store'],
          ['content-type', 'application/json'],
        ],
      ]),
    ]);
    // Tolerance: every median within 50 % of the smallest, or within 25 ms (scheduler noise on a
    // ~70–120 ms hash at 56 MiB: about 70–90 ms on the VM, about 115 ms in CI). A path that skipped
    // the hash would be several times faster.
    const medians = Object.values(times).map(median);
    const lo = Math.min(...medians);
    const hi = Math.max(...medians);
    console.info(
      'password timing medians (ms)',
      Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v).toFixed(1)])),
    );
    expect(hi - lo).toBeLessThanOrEqual(Math.max(25, lo * 0.5));
  }, 60_000);

  it('every failed path runs exactly one hash through the gate (the dummy where there is no hash)', async () => {
    const counting = countingGate();
    const prev = app;
    app = makeApp({ hashGate: counting });
    try {
      const noPw = await a.newUser();
      const withPw = await member();
      const deleted = await member({ status: 'deleted' });
      const badHash = await member({ password_hash: '$argon2id$v=19$garbage' });
      const cases: Record<string, () => Response | Promise<Response>> = {
        unknown: () => signIn(`nobody.gate.${process.pid}@example.org`, PW),
        nopassword: () => signIn(noPw.email, PW),
        wrong: () => signIn(withPw.email, `${PW}!`),
        deleted: () => signIn(deleted.email, PW),
        unparseable: () => signIn(badHash.email, PW),
        adminOtherEmail: () => signIn(withPw.email, PW, { host: 'admin.mjk.test', access: 'other@example.org' }),
      };
      for (const [name, run] of Object.entries(cases)) {
        counting.runs = 0;
        const r = await run();
        expect(r.status, name).toBe(401);
        expect(counting.runs, name).toBe(1);
      }
    } finally {
      app = prev;
    }
  });
});

describe('POST /auth/password: a correct password', () => {
  it('200 with the exact cookie and the Me body; only sha256(token) is stored', async () => {
    const u = await member();
    const r = await signIn(u.email, PW);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const token = tokenOf(r);
    expect(r.headers.get('set-cookie')).toBe(
      `__Host-mjk_sid=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000`,
    );
    const body = Me.parse(await r.json());
    expect(body.user).toMatchObject({ handle: u.handle, email: u.email, role: 'user', has_password: true });
    const rows = await a.admin.query<{ j: string; id: Buffer; method: string; host: string }>(
      'SELECT row_to_json(s)::text AS j, id, method, host FROM session s WHERE user_id = $1',
      [u.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.id.equals(idOf(token))).toBe(true);
    expect(rows.rows[0]).toMatchObject({ method: 'password', host: 'public' });
    expect(rows.rows[0]?.j).not.toContain(token);
  });

  it('deletes the row of the session cookie sent with it', async () => {
    const u = await member();
    const old = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    secrets.push(old.token);
    const r = await signIn(u.email, PW, { cookie: old.token });
    expect(r.status).toBe(200);
    const token = tokenOf(r);
    const ids = (await sessionsOf(u.id)).map((s) => s.id.toString('hex'));
    expect(ids).toEqual([idOf(token).toString('hex')]);
  });

  it('a banned account is 403 banned with no session; a deleted one is the unknown-email 401', async () => {
    const banned = await member({ status: 'banned' });
    const r1 = await signIn(banned.email, PW);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toEqual({ error: 'banned' });
    expect(r1.headers.get('set-cookie')).toBeNull();
    expect(await sessionsOf(banned.id)).toHaveLength(0);
    // A wrong password on a banned account says nothing about the ban.
    expect((await signIn(banned.email, `${PW}?`)).status).toBe(401);

    const deleted = await member({ status: 'deleted' });
    const r2 = await signIn(deleted.email, PW);
    expect(r2.status).toBe(401);
    expect(await r2.text()).toBe('{"error":"unauthorized"}');
    expect(await sessionsOf(deleted.id)).toHaveLength(0);
  });

  it('criterion 11: a hash with older parameters is redone with the current ones', async () => {
    const older = await hashPassword(PW, { ...ARGON2_PARAMS, memoryKiB: 19_456 });
    expect(needsRehash(older)).toBe(true);
    const u = await member({ password_hash: older });
    expect((await signIn(u.email, PW)).status).toBe(200);
    const now = await hashOf(u.id);
    expect(now).not.toBe(older);
    expect(now).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMS.memoryKiB},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}\\$`,
      ),
    );
    expect(needsRehash(now as string)).toBe(false);
    // The new hash still signs in.
    expect((await signIn(u.email, PW)).status).toBe(200);
  });
});

describe('POST /auth/password: criterion 11, the hash gate under load', () => {
  it('50 parallel sign-ins (25 unknown, 25 wrong passwords) are 401 or 429, never 5xx; ≤ 2 hashes at once', async () => {
    const users = [];
    for (let i = 0; i < 25; i++) users.push(await member());
    const rs = await Promise.all([
      ...users.map((u) => signIn(u.email, `${PW}#`)),
      ...users.map((_, i) => signIn(`ghost${i}.${process.pid}@example.org`, PW)),
    ]);
    for (const r of rs) expect([401, 429]).toContain(r.status);
    expect(hashGate.maxInFlight).toBeLessThanOrEqual(2);
    expect(hashGate.inFlight).toBe(0);
  }, 60_000);

  it('at the 64 MiB ceiling: ten parallel right-password sign-ins are 200 or 429; ≤ 2 hashes at once', async () => {
    const big = await hashPassword(PW, { ...ARGON2_PARAMS, memoryKiB: 65_536 });
    const u = await member({ password_hash: big });
    const rs = await Promise.all(Array.from({ length: 10 }, () => signIn(u.email, PW)));
    const statuses = rs.map((r) => r.status);
    for (const s of statuses) expect([200, 429]).toContain(s);
    // The per-email limit (5 per 15 min) refuses five of the ten before any hash; the rest verify.
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of rs) if (r.status === 200) tokenOf(r);
    expect(hashGate.maxInFlight).toBeLessThanOrEqual(2);
  }, 60_000);

  it('a waiter that gets no permit in time is 429 with Retry-After', async () => {
    const gate = createHashGate({ permits: 2, waitMs: 50 });
    const gated = makeApp({ hashGate: gate });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holders = [gate.run(() => held), gate.run(() => held)];
    const u = await member();
    const prev = app;
    app = gated;
    try {
      for (const email of [u.email, `waiter.${process.pid}@example.org`]) {
        const r = await signIn(email, PW);
        expect(r.status).toBe(429);
        expect(r.headers.get('retry-after')).toBe('2');
        expect(await r.json()).toEqual({ error: 'rate_limited' });
      }
    } finally {
      app = prev;
      release();
      await Promise.all(holders);
    }
  });
});

describe('POST /auth/password: limits', () => {
  it('the 6th sign-in for one email within 15 minutes is a 429 with Retry-After', async () => {
    const u = await member();
    for (let i = 0; i < 5; i++) expect((await signIn(u.email, `${PW}${i}`)).status).toBe(401);
    const r = await signIn(u.email, PW);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('the 21st sign-in from one IPv4 /24 within an hour is a 429', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await signIn(`prefix${i}.${process.pid}@example.org`, PW, { peer: `198.51.100.${i + 1}` });
      expect(r.status).toBe(401);
    }
    const r = await signIn(`prefix20.${process.pid}@example.org`, PW, { peer: '198.51.100.200' });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('an unknown client is refused', async () => {
    const u = await member();
    const r = await signIn(u.email, PW, { peer: 'none' });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
    expect(await sessionsOf(u.id)).toHaveLength(0);
  });
});

describe('POST /auth/password: the admin host', () => {
  it('only the Access JWT’s own email gets a session there', async () => {
    const u = await member();
    const other = await signIn(u.email, PW, { host: 'admin.mjk.test', access: 'someone.else@example.org' });
    expect(other.status).toBe(401);
    expect(await other.text()).toBe('{"error":"unauthorized"}');
    expect(other.headers.get('set-cookie')).toBeNull();
    expect(await sessionsOf(u.id)).toHaveLength(0);

    const own = await signIn(u.email, PW, { host: 'admin.mjk.test', access: u.email.toUpperCase() });
    expect(own.status).toBe(200);
    const token = tokenOf(own);
    expect(own.headers.get('set-cookie')).toContain(`Max-Age=${7 * 86_400}`);
    const rows = await sessionsOf(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.host).toBe('admin');
    expect(rows[0]?.id.equals(idOf(token))).toBe(true);
  });
});

describe('POST /auth/password: the per-email limit by host', () => {
  it('a full public-host bucket for an email leaves the admin-host sign-in of that email working', async () => {
    const u = await member();
    for (let i = 0; i < 5; i++) expect((await signIn(u.email, `${PW}${i}`)).status).toBe(401);
    expect((await signIn(u.email, PW)).status).toBe(429);
    const own = await signIn(u.email, PW, { host: 'admin.mjk.test', access: u.email });
    expect(own.status).toBe(200);
    tokenOf(own);
  });
});

describe('PUT and DELETE /me/password', () => {
  /** A member signed in by password (a fresh reauth) with one more session elsewhere. */
  const signedIn = async () => {
    const u = await member();
    const token = tokenOf(await signIn(u.email, PW));
    const other = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    secrets.push(other.token);
    return { u, token, other };
  };

  it('without a session: 401', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const r = await call(method === 'PUT' ? { password: 'a new password here' } : undefined, {
        method,
        path: '/me/password',
      });
      expect(r.status, method).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('more than 10 minutes after the sign-in: 403 reauth_required, nothing changes', async () => {
    const { u, token, other } = await signedIn();
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '11 minutes' WHERE id = $1", [idOf(token)]);
    for (const method of ['PUT', 'DELETE']) {
      const r = await call(method === 'PUT' ? { password: 'a new password here' } : undefined, {
        method,
        path: '/me/password',
        cookie: token,
      });
      expect(r.status, method).toBe(403);
      expect(await r.json()).toEqual({ error: 'reauth_required' });
    }
    expect(await hashOf(u.id)).toBe(pwHash);
    expect((await sessionsOf(u.id)).map((s) => s.id.toString('hex')).sort()).toEqual(
      [idOf(token), idOf(other.token)].map((b) => b.toString('hex')).sort(),
    );
  });

  it('PUT: a password under 12 characters is a 400', async () => {
    const { token } = await signedIn();
    const r = await call({ password: 'x'.repeat(11) }, { method: 'PUT', path: '/me/password', cookie: token });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_request', fields: ['password'] });
  });

  it('PUT: 204, a new hash, every other session ended, this one kept', async () => {
    const { u, token } = await signedIn();
    const next = 'another long passphrase';
    secrets.push(next);
    const r = await call({ password: next }, { method: 'PUT', path: '/me/password', cookie: token });
    expect(r.status).toBe(204);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const stored = await hashOf(u.id);
    expect(stored).not.toBe(pwHash);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
    expect((await sessionsOf(u.id)).map((s) => s.id.toString('hex'))).toEqual([idOf(token).toString('hex')]);
    expect((await signIn(u.email, next)).status).toBe(200);
    expect((await signIn(u.email, PW)).status).toBe(401);
  });

  it('PUT: the 6th within 15 minutes is a 429 before any hash; another member is unaffected', async () => {
    const { u, token } = await signedIn();
    const other = await signedIn();
    const counting = countingGate();
    const prev = app;
    app = makeApp({ hashGate: counting });
    try {
      const put = (cookie: string, i: number) => {
        const password = `a new password number ${i}`;
        secrets.push(password);
        return call({ password }, { method: 'PUT', path: '/me/password', cookie });
      };
      for (let i = 0; i < 5; i++) expect((await put(token, i)).status).toBe(204);
      expect(counting.runs).toBe(5);
      const before = await hashOf(u.id);
      const r = await put(token, 5);
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await r.json()).toEqual({ error: 'rate_limited' });
      expect(counting.runs).toBe(5);
      expect(await hashOf(u.id)).toBe(before);
      expect((await put(other.token, 6)).status).toBe(204);
      expect(counting.runs).toBe(6);
    } finally {
      app = prev;
    }
  }, 30_000);

  it('DELETE: 204 without a body, the hash is NULL, every other session ended, this one kept', async () => {
    const { u, token } = await signedIn();
    const r = await call(undefined, { method: 'DELETE', path: '/me/password', cookie: token });
    expect(r.status).toBe(204);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await hashOf(u.id)).toBeNull();
    expect((await sessionsOf(u.id)).map((s) => s.id.toString('hex'))).toEqual([idOf(token).toString('hex')]);
    expect((await signIn(u.email, PW)).status).toBe(401);
  });
});

describe('logs', () => {
  it('never hold an email, a password, a hash, a token or a cookie', () => {
    const text = JSON.stringify(lines());
    expect(lines().length).toBeGreaterThan(50);
    for (const s of secrets) expect(text).not.toContain(s);
    // The emails' local parts, too (a log could hold a fragment).
    expect(text).not.toMatch(/@example\.org/);
  });
});
