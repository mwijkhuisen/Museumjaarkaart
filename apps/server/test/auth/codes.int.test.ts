import { ErrorBody, Me } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsApp, altchaPayload, codeFor, tokenOf } from './app.ts';
import { type AuthDb, openAuthDb, tablesHolding } from './fixtures.ts';

// Criteria 1, 2 and 9 (A§9): a code fails after 5 attempts (parallel guesses too) and after 10
// minutes, works once, is stored only as its HMAC, a new code voids the old one, the code-request
// and failed-check limits, and the site-wide ALTCHA threshold. The worker's side (the send, the
// drop rules, the sealed value nulled) is mail-jobs.int.test.ts.

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
let n = 0;
const peer = () => `198.51.${100 + (n % 50)}.${(n++ % 200) + 1}`;

beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

const requestCode = async (email: string, p = peer(), host = 'mjk.test') =>
  t.req('/auth/code', {
    host,
    peer: p,
    body: { email, purpose: 'signin', altcha: await altchaPayload(t.req, host), locale: 'nl' },
  });
const verify = (email: string, code: string, p = peer(), extra: Record<string, unknown> = {}, host = 'mjk.test') =>
  t.req('/auth/code/verify', { host, peer: p, body: { email, purpose: 'signin', code, ...extra } });
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('a sign-in code', () => {
  it('signs in once, by the newest code only, stored only as its HMAC', async () => {
    const u = await a.newUser();
    expect((await requestCode(u.email)).status).toBe(202);
    const first = await codeFor(a, t.keys, u.email);
    expect((await requestCode(u.email)).status).toBe(202);
    const second = await codeFor(a, t.keys, u.email);
    // No row of any table holds either code in clear (the job holds it sealed).
    // As a JSON string (a bare 6-digit run can occur by chance in a timestamp or a hex hash).
    for (const c of [first, second]) expect(await tablesHolding(a, `"${c}"`)).toEqual([]);
    // The first code was voided by the second, unless both are the same 6 digits.
    if (first !== second) expect((await verify(u.email, first)).status).toBe(401);
    const ok = await verify(u.email, second);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(Me.parse(await ok.json()).user?.email).toBe(u.email);
    expect(tokenOf(ok)).not.toBeNull();
    // Single use.
    expect((await verify(u.email, second)).status).toBe(401);
  });

  it('is refused after 5 wrong attempts, even in parallel, and after 10 minutes', async () => {
    const u = await a.newUser();
    await requestCode(u.email);
    const code = await codeFor(a, t.keys, u.email);
    const guesses = await Promise.all(Array.from({ length: 8 }, () => verify(u.email, wrong(code))));
    for (const g of guesses) expect(g.status).toBe(401);
    expect(
      (await a.admin.query('SELECT max(attempts) AS m FROM email_code WHERE email = $1', [u.email])).rows[0]?.m,
    ).toBe(5);
    expect((await verify(u.email, code)).status).toBe(401);

    await requestCode(u.email);
    const fresh = await codeFor(a, t.keys, u.email);
    await a.admin.query("UPDATE email_code SET expires_at = now() - interval '1 second' WHERE email = $1", [u.email]);
    expect((await verify(u.email, fresh)).status).toBe(401);
  });

  it('every failure is the same 401 body: wrong, unknown email, expired, used', async () => {
    const bodies = new Set<string>();
    for (const r of [await verify('nobody@example.org', '123456'), await verify('x@example.org', '000000')])
      bodies.add(await r.text());
    expect(bodies.size).toBe(1);
    expect(ErrorBody.parse(JSON.parse([...bodies][0] as string))).toEqual({ error: 'unauthorized' });
  });

  it('a request for an unknown email answers 202 like a known one (the worker drops it)', async () => {
    const u = await a.newUser();
    const known = await requestCode(u.email);
    const unknown = await requestCode(`ghost${n}@example.org`);
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.text()).toBe(await unknown.text());
  });

  it('a banned account → 403 banned with no session; a deleted one → 401', async () => {
    const banned = await a.newUser({ status: 'banned' });
    await requestCode(banned.email);
    const r = await verify(banned.email, await codeFor(a, t.keys, banned.email));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'banned' });
    expect(r.headers.get('set-cookie')).toBeNull();
    const gone = await a.newUser({ status: 'deleted' });
    await requestCode(gone.email);
    expect((await verify(gone.email, await codeFor(a, t.keys, gone.email))).status).toBe(401);
  });

  it('signing in with a session cookie present deletes that row', async () => {
    const u = await a.newUser();
    await requestCode(u.email);
    const first = await verify(u.email, await codeFor(a, t.keys, u.email));
    const old = tokenOf(first) as string;
    await requestCode(u.email);
    const again = await t.req('/auth/code/verify', {
      cookie: old,
      body: { email: u.email, purpose: 'signin', code: await codeFor(a, t.keys, u.email) },
    });
    expect(again.status).toBe(200);
    const rows = await a.admin.query('SELECT count(*)::int AS n FROM session WHERE user_id = $1', [u.id]);
    expect(rows.rows[0]?.n).toBe(1);
  });
});

describe('the limits (A§9)', () => {
  it('the 4th code request for one email from one prefix in 15 minutes → 429; another prefix still gets one', async () => {
    const u = await a.newUser();
    for (let i = 0; i < 3; i++) expect((await requestCode(u.email, `203.0.113.${10 + i}`)).status).toBe(202);
    const fourth = await requestCode(u.email, '203.0.113.99');
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = await requestCode(u.email, '198.18.0.1');
    expect(other.status).toBe(202);
  });

  it('the 31st failed check from one prefix within an hour → 429', async () => {
    const u = await a.newUser();
    for (let i = 0; i < 30; i++) expect((await verify(u.email, '000000', `10.31.0.${i + 1}`)).status).toBe(401);
    expect((await verify(u.email, '000000', '10.31.0.250')).status).toBe(429);
    // Another prefix is not affected.
    expect((await verify(u.email, '000000', '198.19.0.1')).status).toBe(401);
  });

  it('a right code refunds its reserved failure slot', async () => {
    const u = await a.newUser();
    await requestCode(u.email, '100.64.0.1');
    await verify(u.email, await codeFor(a, t.keys, u.email), '100.64.0.2');
    const rows = await a.admin.query(
      "SELECT count FROM rate_limit WHERE bucket = 'verify_fail_prefix' AND key = '100.64.0.0/24'",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('above 500 failures an hour site-wide, verify also needs an ALTCHA solution', async () => {
    await a.admin.query(
      `INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
       VALUES ('verify_fail_site', 'site', to_timestamp(floor(extract(epoch from now()) / 3600) * 3600),
               to_timestamp(floor(extract(epoch from now()) / 3600) * 3600 + 3600), 500)
       ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = 500`,
    );
    const u = await a.newUser();
    await requestCode(u.email);
    const code = await codeFor(a, t.keys, u.email);
    const without = await verify(u.email, code);
    expect(without.status).toBe(400);
    expect(await without.json()).toEqual({ error: 'bad_request', fields: ['altcha'] });
    const withAltcha = await verify(u.email, code, peer(), { altcha: await altchaPayload(t.req) });
    expect(withAltcha.status).toBe(200);
    await a.admin.query("DELETE FROM rate_limit WHERE bucket = 'verify_fail_site'");
  });

  it('an unknown client is refused', async () => {
    const r = await t.req('/auth/code', {
      peer: 'none',
      body: { email: 'x@example.org', purpose: 'signin', altcha: await altchaPayload(t.req), locale: 'nl' },
    });
    expect(r.status).toBe(429);
  });
});

describe('the admin host', () => {
  it('signs in only the Access JWT’s own email, and a public cookie never counts there', async () => {
    const u = await a.newUser();
    const admin = { 'x-test-access': u.email };
    const req = (path: string, body: unknown, headers = admin) =>
      t.req(path, { host: 'admin.mjk.test', peer: '10.32.0.1', headers, body });
    // Another email: the same 202, and no code.
    const before = await a.admin.query('SELECT count(*)::int AS n FROM email_code');
    expect(
      (
        await req('/auth/code', {
          email: 'other@example.org',
          purpose: 'signin',
          altcha: await altchaPayload(t.req, 'admin.mjk.test'),
          locale: 'nl',
        })
      ).status,
    ).toBe(202);
    expect((await a.admin.query('SELECT count(*)::int AS n FROM email_code')).rows[0]?.n).toBe(before.rows[0]?.n);
    // The JWT's email: a code, and a host = admin session.
    await req('/auth/code', {
      email: u.email,
      purpose: 'signin',
      altcha: await altchaPayload(t.req, 'admin.mjk.test'),
      locale: 'nl',
    });
    const ok = await req('/auth/code/verify', {
      email: u.email,
      purpose: 'signin',
      code: await codeFor(a, t.keys, u.email),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain(`Max-Age=${7 * 86_400}`);
    const host = await a.admin.query('SELECT host FROM session WHERE user_id = $1', [u.id]);
    expect(host.rows.map((r) => r.host)).toEqual(['admin']);
    // A right code for the JWT's email is refused when the body names another purpose (sign-up never completes here).
    expect((await req('/auth/code/verify', { email: u.email, purpose: 'signup', code: '000000' })).status).toBe(401);
  });

  it('a public-host ALTCHA solution is refused on the admin host', async () => {
    const u = await a.newUser();
    const r = await t.req('/auth/code', {
      host: 'admin.mjk.test',
      headers: { 'x-test-access': u.email },
      body: { email: u.email, purpose: 'signin', altcha: await altchaPayload(t.req, 'mjk.test'), locale: 'nl' },
    });
    expect(r.status).toBe(400);
  });

  it('sign-up does not exist there', async () => {
    const r = await t.req('/auth/signup', {
      host: 'admin.mjk.test',
      headers: { 'x-test-access': 'x@example.org' },
      body: {},
    });
    expect(r.status).toBe(404);
  });
});

describe('sign-out', () => {
  it('ends this session (or every one) and clears the cookie', async () => {
    const u = await a.newUser();
    await requestCode(u.email);
    const s1 = tokenOf(await verify(u.email, await codeFor(a, t.keys, u.email))) as string;
    await requestCode(u.email, '100.65.0.1');
    const s2 = tokenOf(await verify(u.email, await codeFor(a, t.keys, u.email), '100.65.0.2')) as string;
    const out = await t.req('/auth/signout', { method: 'POST', cookie: s1 });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toBe('__Host-mjk_sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    const count = async () =>
      (await a.admin.query('SELECT count(*)::int AS n FROM session WHERE user_id = $1', [u.id])).rows[0]?.n;
    expect(await count()).toBe(1);
    expect((await t.req('/auth/signout-all', { method: 'POST' })).status).toBe(401);
    expect((await t.req('/auth/signout-all', { method: 'POST', cookie: s2 })).status).toBe(204);
    expect(await count()).toBe(0);
  });
});
