import { randomBytes } from 'node:crypto';
import { Me, PasskeyRegistrationOptions, PasskeySignInOptions } from '@mjk/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/auth/crypto.ts';
import { loadSession, startSession } from '../../src/auth/session.ts';
import {
  mintChallenge,
  registrationOptions,
  signInOptions,
  spendChallenge,
  verifyRegistration,
  verifySignIn,
  WEBAUTHN_TTL_S,
  type WebAuthnDeps,
} from '../../src/auth/webauthn.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { accountsApp, SITE, tokenOf } from './app.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';
import { type Attestation, type Cbor, type SoftCredential, softCredential } from './soft-authenticator.ts';

// P2b criteria 2, 3, 5 and 6 (issue #18), with responses forged by a software authenticator:
//   2  another RP ID or origin, a reused or expired challenge, no UV flag → refused (sign-in and registration)
//   3  an assertion made on https://<domain> is refused by the admin host's verify, and the other way round
//   5  a deleted passkey stops working at once; another user's credential never signs in to this account
//   6  a non-zero counter that does not grow is refused and logged with a fixed code, no key material
// The routes run over accountsApp (x-test-access stands in for the Access JWT; admin-host.int.test.ts
// runs the real JWT); the registration core is called directly (its routes are me-passkeys.int.test.ts's).

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

let n = 0;
/** A /24 of its own for each test, so the limiter's buckets never meet. */
const peer = () => `198.18.${++n}.9`;
const ADMIN = 'admin.mjk.test';
const PUBLIC_ORIGIN = 'https://mjk.test';
const ADMIN_ORIGIN = 'https://admin.mjk.test';

const handleOf = async (userId: string): Promise<Buffer> =>
  (await a.admin.query<{ h: Buffer }>('SELECT webauthn_user_id AS h FROM app_user WHERE id = $1', [userId])).rows[0]
    ?.h as Buffer;

/** A member with one stored passkey (inserted as the registration would store it). */
async function enrolled(opts: { counter?: number; status?: string; alg?: 'ES256' | 'EdDSA' } = {}) {
  const user = await a.newUser(opts.status === undefined ? {} : { status: opts.status });
  const cred = softCredential({
    userHandle: await handleOf(user.id),
    counter: opts.counter ?? 0,
    alg: opts.alg ?? 'ES256',
  });
  await store(user.id, cred);
  return { user, cred };
}

async function store(userId: string, cred: SoftCredential) {
  await a.admin.query(
    `INSERT INTO passkey (credential_id, user_id, public_key, sign_count, transports, backed_up)
     VALUES ($1, $2, $3, $4, '{internal}', false)`,
    [cred.id, userId, cred.publicKeyCose, cred.counter],
  );
}

type Opts = { host?: string; peer?: string; access?: string; cookie?: string };
const headersOf = (o: Opts): Record<string, string> => (o.access === undefined ? {} : { 'x-test-access': o.access });

async function options(o: Opts = {}): Promise<string> {
  const r = await t.req('/auth/passkey/options', {
    method: 'POST',
    host: o.host ?? 'mjk.test',
    peer: o.peer ?? '192.0.2.1',
    headers: headersOf(o),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return PasskeySignInOptions.parse(await r.json()).challenge;
}

const verify = (credential: unknown, o: Opts = {}) =>
  t.req('/auth/passkey/verify', {
    body: { credential },
    host: o.host ?? 'mjk.test',
    peer: o.peer ?? '192.0.2.1',
    headers: headersOf(o),
    ...(o.cookie === undefined ? {} : { cookie: o.cookie }),
  });

const linesSince = (from: number) => t.lines().slice(from);
const reasons = (from: number) =>
  linesSince(from)
    .filter((l) => l.msg === 'passkey_refused' || l.msg === 'passkey_counter')
    .map((l) => (l.msg === 'passkey_counter' ? 'counter' : String(l.reason)));

const countRows = async (sql: string, params: unknown[]) =>
  Number((await a.admin.query<{ n: string }>(sql, params)).rows[0]?.n);

describe('POST /auth/passkey/options', () => {
  it('answers a fresh signed challenge with no credential list, the RP ID and UV required, and writes nothing', async () => {
    const before = await countRows('SELECT count(*) AS n FROM auth_challenge', []);
    const r = await t.req('/auth/passkey/options', { method: 'POST' });
    const body = PasskeySignInOptions.parse(await r.json());
    expect(body).toEqual({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{72}$/),
      rpId: 'mjk.test',
      timeout: WEBAUTHN_TTL_S * 1_000,
      userVerification: 'required',
    });
    expect(await options()).not.toBe(body.challenge);
    expect(await countRows('SELECT count(*) AS n FROM auth_challenge', [])).toBe(before);
    expect(await countRows('SELECT count(*) AS n FROM rate_limit', [])).toBe(0);
  });

  it('refuses a query string, and on the admin host answers the same shape', async () => {
    expect((await t.req('/auth/passkey/options?x=1', { method: 'POST' })).status).toBe(400);
    const r = await t.req('/auth/passkey/options', {
      method: 'POST',
      host: ADMIN,
      headers: { 'x-test-access': 'x@y.z' },
    });
    expect(PasskeySignInOptions.parse(await r.json()).rpId).toBe('mjk.test');
  });
});

describe('POST /auth/passkey/verify: a good assertion', () => {
  it('signs in: 200 Me, a new session with method passkey, the counter and last use stored', async () => {
    const { user, cred } = await enrolled({ counter: 7 });
    const p = peer();
    // A cookie sent with the request is never kept (A§9): its row goes.
    const old = await startSession(a.db, { userId: user.id, host: 'public', method: 'code', sentToken: null });
    const r = await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p, cookie: old.token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(Me.parse(await r.json()).user?.handle).toBe(user.handle);
    const token = tokenOf(r);
    expect(token).not.toBeNull();
    const s = await loadSession(a.db, token as string, 'public');
    expect(s?.method).toBe('passkey');
    expect(s?.user.id).toBe(user.id);
    expect(s?.reauthFresh).toBe(true);
    expect(await loadSession(a.db, old.token, 'public')).toBeNull();
    const row = (
      await a.admin.query<{ sign_count: string; last_used_at: Date | null }>(
        'SELECT sign_count, last_used_at FROM passkey WHERE credential_id = $1',
        [cred.id],
      )
    ).rows[0];
    expect(row?.sign_count).toBe('8');
    expect(row?.last_used_at).not.toBeNull();
    // the challenge is spent once, by its hash, with its host
    expect(
      await countRows("SELECT count(*) AS n FROM auth_challenge WHERE purpose = 'webauthn' AND host = 'public'", []),
    ).toBeGreaterThan(0);
  });

  it('works with EdDSA and with a counterless authenticator (0 stays 0)', async () => {
    const { cred } = await enrolled({ alg: 'EdDSA' });
    const p = peer();
    expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
    expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
  });

  it('stores the backed-up flag the authenticator reports', async () => {
    const { cred } = await enrolled();
    const p = peer();
    expect(
      (await verify(cred.assert({ challenge: await options({ peer: p }), backedUp: true }), { peer: p })).status,
    ).toBe(200);
    const row = (await a.admin.query('SELECT backed_up FROM passkey WHERE credential_id = $1', [cred.id])).rows[0];
    expect(row?.backed_up).toBe(true);
  });
});

describe('criterion 2: another RP ID or origin, a reused or expired challenge, no UV flag', () => {
  it.each([
    ['another RP ID', { rpId: 'evil.test' }],
    ['the parent of the RP ID', { rpId: 'test' }],
    ['another origin', { origin: 'https://evil.test' }],
    ['http instead of https', { origin: 'http://mjk.test' }],
    ['a port on the origin', { origin: 'https://mjk.test:8443' }],
    ['a subdomain as origin', { origin: 'https://media.mjk.test' }],
    ['no UV flag', { uv: false }],
    ['no UP flag', { up: false }],
    ['a registration type', { type: 'webauthn.create' }],
    ['crossOrigin: true', { crossOrigin: true }],
    ['crossOrigin with a topOrigin', { crossOrigin: true, topOrigin: 'https://evil.test' }],
  ])('%s → 401, no session', async (_name, forged) => {
    const { cred } = await enrolled();
    const p = peer();
    const sessions = await countRows('SELECT count(*) AS n FROM session', []);
    const r = await verify(cred.assert({ challenge: await options({ peer: p }), ...forged }), { peer: p });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(await countRows('SELECT count(*) AS n FROM session', [])).toBe(sessions);
  });

  it('a reused challenge: the same assertion twice, or a new assertion on a spent challenge → 401', async () => {
    const { cred } = await enrolled();
    const p = peer();
    const challenge = await options({ peer: p });
    const first = cred.assert({ challenge });
    expect((await verify(first, { peer: p })).status).toBe(200);
    const from = t.lines().length;
    expect((await verify(first, { peer: p })).status).toBe(401);
    expect((await verify(cred.assert({ challenge }), { peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['replay', 'replay']);
  });

  it('a replay racing the original: exactly one of two parallel verifies signs in', async () => {
    const { cred } = await enrolled();
    const p = peer();
    const assertion = cred.assert({ challenge: await options({ peer: p }) });
    const statuses = (await Promise.all([verify(assertion, { peer: p }), verify(assertion, { peer: p })])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([200, 401]);
  });

  it('an expired challenge (by the process clock) → 401', async () => {
    const { cred } = await enrolled();
    const p = peer();
    const old = mintChallenge(t.keys, 'public', 'signin', [], Date.now() / 1_000 - WEBAUTHN_TTL_S - 1);
    const from = t.lines().length;
    expect((await verify(cred.assert({ challenge: old.toString('base64url') }), { peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['challenge']);
  });

  it('the spend checks the expiry with its own statement’s clock, not the transaction’s start (L4)', async () => {
    // A transaction that began before the expiry and spends after it: now() would still pass it, and a
    // purge in between could already have deleted the first spend's row.
    const bytes = randomBytes(54);
    const spent = await a.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ s: number }>`SELECT extract(epoch from now())::float8 AS s`.execute(trx);
      const expS = Math.ceil(Number(rows[0]?.s)) + 1;
      await sql`SELECT pg_sleep(${expS - Number(rows[0]?.s) + 0.2}::float8)`.execute(trx);
      return spendChallenge(trx, 'public', { bytes, expS });
    });
    expect(spent).toBe(false);
    expect(await countRows('SELECT count(*) AS n FROM auth_challenge WHERE value_hash = $1', [sha256(bytes)])).toBe(0);
  });

  it('an expired challenge by the database clock alone: the spend refuses it and nothing is written', async () => {
    // A process clock 400 s slow: the challenge checks as fresh, but its expiry has passed by now().
    const { cred, user } = await enrolled();
    const { logger, lines } = memoryLogger('api');
    const slow: WebAuthnDeps = { db: a.db, keys: t.keys, site: SITE, logger, nowS: () => Date.now() / 1_000 - 400 };
    const options = signInOptions(slow, 'public');
    const before = await countRows('SELECT count(*) AS n FROM auth_challenge', []);
    const result = await verifySignIn(slow, {
      host: 'public',
      credential: cred.assert({ challenge: options.challenge }),
      accessEmail: undefined,
      sentToken: null,
    });
    expect(result).toEqual({ ok: false, code: 'unauthorized' });
    expect(lines().map((l) => l.reason)).toEqual(['replay']);
    expect(await countRows('SELECT count(*) AS n FROM auth_challenge', [])).toBe(before);
    expect(await countRows('SELECT count(*) AS n FROM session WHERE user_id = $1', [user.id])).toBe(0);
  });

  it('a challenge minted with another key, or a registration challenge → 401', async () => {
    const { cred } = await enrolled();
    const p = peer();
    const reg = mintChallenge(t.keys, 'public', 'register', [], Date.now() / 1_000);
    expect((await verify(cred.assert({ challenge: reg.toString('base64url') }), { peer: p })).status).toBe(401);
    const forged = Buffer.alloc(54, 1).toString('base64url');
    expect((await verify(cred.assert({ challenge: forged }), { peer: p })).status).toBe(401);
  });
});

describe('criterion 3: one host’s assertion never signs in on the other', () => {
  async function member() {
    const e = await enrolled();
    return { ...e, access: e.user.email };
  }

  it('control: an admin-host ceremony signs in on the admin host (the JWT email is the member’s)', async () => {
    const { cred, access } = await member();
    const p = peer();
    const challenge = await options({ host: ADMIN, access, peer: p });
    const r = await verify(cred.assert({ challenge, origin: ADMIN_ORIGIN }), { host: ADMIN, access, peer: p });
    expect(r.status).toBe(200);
    expect((await loadSession(a.db, tokenOf(r) as string, 'admin'))?.method).toBe('passkey');
  });

  it('a public-host assertion (public challenge and origin) → 401 on the admin host', async () => {
    const { cred, access } = await member();
    const p = peer();
    const assertion = cred.assert({ challenge: await options({ peer: p }), origin: PUBLIC_ORIGIN });
    expect((await verify(assertion, { host: ADMIN, access, peer: p })).status).toBe(401);
  });

  it('an admin-host assertion (admin challenge and origin) → 401 on the public host', async () => {
    const { cred, access } = await member();
    const p = peer();
    const assertion = cred.assert({ challenge: await options({ host: ADMIN, access, peer: p }), origin: ADMIN_ORIGIN });
    expect((await verify(assertion, { peer: p })).status).toBe(401);
  });

  it('the challenge binds: an admin challenge with the public origin → 401 on both hosts', async () => {
    const { cred, access } = await member();
    const p = peer();
    const challenge = await options({ host: ADMIN, access, peer: p });
    expect((await verify(cred.assert({ challenge, origin: PUBLIC_ORIGIN }), { peer: p })).status).toBe(401);
    expect(
      (await verify(cred.assert({ challenge, origin: PUBLIC_ORIGIN }), { host: ADMIN, access, peer: p })).status,
    ).toBe(401);
  });

  it('the origin binds: a public challenge with the admin origin → 401 on both hosts', async () => {
    const { cred, access } = await member();
    const p = peer();
    const challenge = await options({ peer: p });
    expect(
      (await verify(cred.assert({ challenge, origin: ADMIN_ORIGIN }), { host: ADMIN, access, peer: p })).status,
    ).toBe(401);
    expect((await verify(cred.assert({ challenge, origin: ADMIN_ORIGIN }), { peer: p })).status).toBe(401);
  });

  it('on the admin host only the Access JWT’s own account signs in', async () => {
    const { cred } = await member();
    const p = peer();
    const from = t.lines().length;
    for (const access of ['someone.else@example.org', undefined]) {
      const challenge = await options({ host: ADMIN, peer: p, ...(access === undefined ? {} : { access }) });
      const r = await verify(cred.assert({ challenge, origin: ADMIN_ORIGIN }), {
        host: ADMIN,
        peer: p,
        ...(access === undefined ? {} : { access }),
      });
      expect(r.status).toBe(401);
    }
    expect(reasons(from)).toEqual(['unknown', 'unknown']);
  });
});

describe('criterion 5: deleted passkeys and other members’ credentials', () => {
  it('a deleted passkey stops working at once', async () => {
    const { cred } = await enrolled();
    const p = peer();
    expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
    const pending = cred.assert({ challenge: await options({ peer: p }) });
    await a.db.deleteFrom('passkey').where('credential_id', '=', cred.id).execute();
    const from = t.lines().length;
    expect((await verify(pending, { peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['unknown']);
  });

  it.each([
    ['deleted', 'DELETE FROM passkey WHERE credential_id = $1'],
    [
      'used concurrently (its counter moved)',
      'UPDATE passkey SET sign_count = sign_count + 3 WHERE credential_id = $1',
    ],
  ])('a passkey %s between the read and the write never signs in (the compare-and-set)', async (_name, change) => {
    const { cred, user } = await enrolled({ counter: 5 });
    const { logger, lines } = memoryLogger('api');
    let changed = 0;
    // The test-only hook runs after every check on the row read, before the spending transaction.
    const wa: WebAuthnDeps = {
      db: a.db,
      keys: t.keys,
      site: SITE,
      logger,
      beforeCommit: async () => {
        changed += (await a.admin.query(change, [cred.id])).rowCount ?? 0;
      },
    };
    const challenge = mintChallenge(t.keys, 'public', 'signin', [], Date.now() / 1_000).toString('base64url');
    const result = await verifySignIn(wa, {
      host: 'public',
      credential: cred.assert({ challenge }),
      accessEmail: undefined,
      sentToken: null,
    });
    expect(changed).toBe(1);
    expect(result).toEqual({ ok: false, code: 'unauthorized' });
    expect(lines().map((l) => l.reason)).toEqual(['changed']);
    expect(await countRows('SELECT count(*) AS n FROM session WHERE user_id = $1', [user.id])).toBe(0);
  });

  it('another member’s credential never signs in to this account', async () => {
    const victim = await enrolled();
    const attacker = await enrolled();
    const p = peer();
    const from = t.lines().length;
    // The attacker's credential with the victim's user handle.
    expect(
      (
        await verify(
          attacker.cred.assert({ challenge: await options({ peer: p }), userHandle: victim.cred.userHandle }),
          { peer: p },
        )
      ).status,
    ).toBe(401);
    // The victim's credential id, signed with the attacker's key.
    const forged = softCredential({ userHandle: victim.cred.userHandle, id: victim.cred.id });
    expect((await verify(forged.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['user_handle', 'verify']);
    // And the attacker's own credential signs the attacker in, never the victim.
    const own = await verify(attacker.cred.assert({ challenge: await options({ peer: p }) }), { peer: p });
    expect(Me.parse(await own.json()).user?.handle).toBe(attacker.user.handle);
  });

  it('a banned member is told so after the signature (403 banned, no session); a deleted one is unknown', async () => {
    const banned = await enrolled({ status: 'banned' });
    const gone = await enrolled({ status: 'deleted' });
    const p = peer();
    const r = await verify(banned.cred.assert({ challenge: await options({ peer: p }) }), { peer: p });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'banned' });
    expect(r.headers.get('set-cookie')).toBeNull();
    // A wrong signature on a banned account is the ordinary 401.
    const bad = banned.cred.assert({ challenge: await options({ peer: p }), badSignature: true });
    expect((await verify(bad, { peer: p })).status).toBe(401);
    expect((await verify(gone.cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(401);
    expect(
      await countRows('SELECT count(*) AS n FROM session WHERE user_id = ANY($1)', [[banned.user.id, gone.user.id]]),
    ).toBe(0);
  });

  it('an unknown credential → 401', async () => {
    const stranger = softCredential({ userHandle: Buffer.alloc(16, 3) });
    const p = peer();
    expect((await verify(stranger.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(401);
  });
});

describe('criterion 6: the signature counter', () => {
  it.each([
    ['equal', 5],
    ['lower', 3],
    ['back to zero', 0],
  ])('a %s counter after 5 → 401 and the fixed warning passkey_counter', async (_name, counter) => {
    const { cred } = await enrolled({ counter: 5 });
    const p = peer();
    const from = t.lines().length;
    const assertion = cred.assert({ challenge: await options({ peer: p }), counter });
    expect((await verify(assertion, { peer: p })).status).toBe(401);
    const warning = linesSince(from).filter((l) => l.msg === 'passkey_counter');
    expect(warning).toHaveLength(1);
    expect(warning[0]?.level).toBe(40);
    // A fixed code only: no key material, id, challenge, handle or counters.
    const { level: _l, time: _t, role: _r, msg: _m, ...fields } = warning[0] as Record<string, unknown>;
    expect(fields).toEqual({});
    const text = JSON.stringify(linesSince(from));
    for (const secret of [
      assertion.id,
      cred.publicKeyCose.toString('base64url'),
      cred.publicKeyCose.toString('hex'),
      cred.publicKeyCose.toString('base64'),
      assertion.response.userHandle,
      assertion.response.signature,
      JSON.parse(Buffer.from(assertion.response.clientDataJSON, 'base64url').toString()).challenge,
    ]) {
      expect(text).not.toContain(secret);
    }
    // the stored counter stays
    expect(
      (await a.admin.query('SELECT sign_count FROM passkey WHERE credential_id = $1', [cred.id])).rows[0]?.sign_count,
    ).toBe('5');
  });

  it('a counter that grows signs in and is stored', async () => {
    const { cred } = await enrolled({ counter: 5 });
    const p = peer();
    expect((await verify(cred.assert({ challenge: await options({ peer: p }), counter: 6 }), { peer: p })).status).toBe(
      200,
    );
    expect((await verify(cred.assert({ challenge: await options({ peer: p }), counter: 6 }), { peer: p })).status).toBe(
      401,
    );
  });

  it('a bad signature with a lower counter logs no passkey_counter: the rule runs only after the signature', async () => {
    const { cred } = await enrolled({ counter: 5 });
    const p = peer();
    const from = t.lines().length;
    const bad = cred.assert({ challenge: await options({ peer: p }), counter: 2, badSignature: true });
    expect((await verify(bad, { peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['verify']);
  });
});

describe('the request and the limiter', () => {
  it('a strict body: an unknown key, padding, a short user handle, id ≠ rawId → 400', async () => {
    const { cred } = await enrolled();
    const good = cred.assert({ challenge: await options() });
    for (const credential of [
      { ...good, clientExtensionResults: {} },
      { ...good, rawId: `${good.rawId}AA` },
      { ...good, response: { ...good.response, signature: `${good.response.signature}=` } },
      { ...good, response: { ...good.response, userHandle: '' } },
    ]) {
      expect((await verify(credential)).status).toBe(400);
    }
    expect((await t.req('/auth/passkey/verify', { body: { credential: good, extra: 1 } })).status).toBe(400);
  });

  it('30 failed verifies an hour per IP prefix, then 429; a verified signature gives its slot back', async () => {
    const { cred } = await enrolled();
    const other = await enrolled();
    const p = peer();
    // Successes do not count (two members, so neither reaches passkey_user_hour).
    for (let i = 0; i < 32; i++) {
      const c = i % 2 === 0 ? cred : other.cred;
      expect((await verify(c.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
    }
    const bad = () => cred.assert({ challenge: 'A'.repeat(72) });
    for (let i = 0; i < 30; i++) expect((await verify(bad(), { peer: p })).status).toBe(401);
    const r = await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(t.lines().at(-2)).toMatchObject({ msg: 'rate_limited', bucket: 'passkey_fail_prefix' });
  });

  it('30 successful sign-ins an hour per member, then 429 with no session (L1); the key is no user id', async () => {
    const { user, cred } = await enrolled();
    const p = peer();
    for (let i = 0; i < 30; i++) {
      expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
    }
    const sessions = await countRows('SELECT count(*) AS n FROM session WHERE user_id = $1', [user.id]);
    const from = t.lines().length;
    const r = await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(await countRows('SELECT count(*) AS n FROM session WHERE user_id = $1', [user.id])).toBe(sessions);
    const limited = linesSince(from).filter((l) => l.msg === 'rate_limited');
    expect(limited).toHaveLength(1);
    const { level: _l, time: _t, role: _r, msg: _m, ...fields } = limited[0] as Record<string, unknown>;
    expect(fields).toEqual({ bucket: 'passkey_user_hour' });
    // The verified signature gave its passkey_fail_prefix slot back.
    expect(
      await countRows(
        "SELECT COALESCE(sum(count), 0) AS n FROM rate_limit WHERE bucket = 'passkey_fail_prefix' AND key = $1",
        [`${p.split('.').slice(0, 3).join('.')}.0/24`],
      ),
    ).toBe(0);
    // Keyed by 64 hex characters of an HMAC, never the id.
    const keys = (
      await a.admin.query<{ key: string; count: number }>(
        "SELECT key, count FROM rate_limit WHERE bucket = 'passkey_user_hour'",
      )
    ).rows;
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key) && !k.key.includes(user.id))).toBe(true);
    expect(keys.some((k) => k.count === 31)).toBe(true);
    // Another member from the same address still signs in.
    const next = await enrolled();
    expect((await verify(next.cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
  });

  it('no client address → 429, before any work', async () => {
    const { cred } = await enrolled();
    const r = await verify(cred.assert({ challenge: await options() }), { peer: 'none' });
    expect(r.status).toBe(429);
  });
});

describe('registration (auth/webauthn.ts; the routes are me-passkeys.int.test.ts’s)', () => {
  const { logger, lines } = memoryLogger('api');
  const wa = (): WebAuthnDeps => ({ db: a.db, keys: t.keys, site: SITE, logger });

  async function signedIn(host: 'public' | 'admin' = 'public') {
    const user = await a.newUser();
    const token = (await startSession(a.db, { userId: user.id, host, method: 'code', sentToken: null })).token;
    const session = await loadSession(a.db, token, host);
    if (session === null) throw new Error('no session');
    return { user, session, cred: softCredential({ userHandle: await handleOf(user.id) }) };
  }

  async function regOptions(host: 'public' | 'admin', session: Awaited<ReturnType<typeof signedIn>>['session']) {
    const o = await registrationOptions(wa(), host, session);
    if (!o.ok) throw new Error('options refused');
    return PasskeyRegistrationOptions.parse(o.options);
  }

  it('options: the handle, never the email; the random user id; none, resident key, UV, three algorithms', async () => {
    const { user, session } = await signedIn();
    const o = await regOptions('public', session);
    expect(o.rp).toEqual({ id: 'mjk.test', name: 'mjk.test' });
    expect(o.user).toEqual({
      id: (await handleOf(user.id)).toString('base64url'),
      name: user.handle,
      displayName: user.handle,
    });
    expect(JSON.stringify(o)).not.toContain(user.email);
    expect(JSON.stringify(o)).not.toContain(user.id);
    expect(o.attestation).toBe('none');
    expect(o.authenticatorSelection).toEqual({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(o.excludeCredentials).toEqual([]);
    expect(o.timeout).toBe(300_000);
  });

  it('stores a verified credential and then lists it in excludeCredentials', async () => {
    const { user, session, cred } = await signedIn();
    const o = await regOptions('public', session);
    const result = await verifyRegistration(wa(), {
      host: 'public',
      session,
      credential: cred.register({
        challenge: o.challenge,
        backedUp: true,
        transports: ['internal', 'hybrid', 'carrier-pigeon'],
      }),
      name: 'Laptop',
    });
    expect(result).toMatchObject({ ok: true, item: { name: 'Laptop', backed_up: true, last_used_at: null } });
    const row = (
      await a.admin.query(
        'SELECT user_id, public_key, sign_count, transports, backed_up FROM passkey WHERE credential_id = $1',
        [cred.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      user_id: user.id,
      sign_count: '0',
      transports: ['internal', 'hybrid'],
      backed_up: true,
    });
    expect(Buffer.compare(row.public_key, cred.publicKeyCose)).toBe(0);
    const again = await regOptions('public', session);
    expect(again.excludeCredentials).toEqual([
      { id: cred.id.toString('base64url'), type: 'public-key', transports: ['internal', 'hybrid'] },
    ]);
    // and the new passkey signs in
    const p = peer();
    expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
  });

  it.each([
    ['another RP ID', { rpId: 'evil.test' }],
    ['another origin', { origin: 'https://evil.test' }],
    ['the admin origin on the public host', { origin: ADMIN_ORIGIN }],
    ['no UV flag', { uv: false }],
    ['no UP flag', { up: false }],
    ['a sign-in type', { type: 'webauthn.get' }],
    ['crossOrigin: true', { crossOrigin: true }],
    ['not discoverable (credProps.rk false)', { rk: false }],
  ])('%s → invalid, nothing stored', async (_name, forged) => {
    const { session, cred } = await signedIn();
    const o = await regOptions('public', session);
    const result = await verifyRegistration(wa(), {
      host: 'public',
      session,
      credential: cred.register({ challenge: o.challenge, ...forged }),
      name: undefined,
    });
    expect(result).toEqual({ ok: false, code: 'invalid' });
    expect(await countRows('SELECT count(*) AS n FROM passkey WHERE credential_id = $1', [cred.id])).toBe(0);
  });

  // H1 (P2b security review): only `none` and `packed` self attestation reach the library, so no
  // X.509 chain is ever walked and no CRL Distribution Point fetched. The bytes are arbitrary: the
  // statement is refused before anything parses them.
  const junk = (n: number) => Buffer.alloc(n, 0x30);
  const stmt = (entries: [string, Cbor][]) => new Map<Cbor, Cbor>(entries);
  const x5c: [string, Cbor] = ['x5c', [junk(300), junk(300)]];
  it.each<[string, Attestation]>([
    ['android-key', { fmt: 'android-key', attStmt: stmt([['alg', -7], ['sig', junk(64)], x5c]) }],
    ['packed with an x5c', { fmt: 'packed', attStmt: stmt([['alg', -7], ['sig', junk(64)], x5c]) }],
    [
      'packed with another key',
      {
        fmt: 'packed',
        attStmt: stmt([
          ['alg', -7],
          ['sig', junk(64)],
          ['ecdaaKeyId', junk(32)],
        ]),
      },
    ],
    ['packed without a sig', { fmt: 'packed', attStmt: stmt([['alg', -7]]) }],
    [
      'packed with a text alg',
      {
        fmt: 'packed',
        attStmt: stmt([
          ['alg', 'ES256'],
          ['sig', junk(64)],
        ]),
      },
    ],
    [
      'tpm',
      {
        fmt: 'tpm',
        attStmt: stmt([
          ['ver', '2.0'],
          ['alg', -257],
          x5c,
          ['sig', junk(256)],
          ['certInfo', junk(99)],
          ['pubArea', junk(99)],
        ]),
      },
    ],
    ['fido-u2f', { fmt: 'fido-u2f', attStmt: stmt([['sig', junk(64)], x5c]) }],
    ['apple', { fmt: 'apple', attStmt: stmt([x5c]) }],
    [
      'android-safetynet',
      {
        fmt: 'android-safetynet',
        attStmt: stmt([
          ['ver', '1'],
          ['response', junk(200)],
        ]),
      },
    ],
    ['none with a statement', { fmt: 'none', attStmt: stmt([x5c]) }],
    ['an unknown format', { fmt: 'other', attStmt: stmt([]) }],
    ['an undecodable attestationObject', { raw: Buffer.from([0xff, 0xff, 0xff]) }],
    ['a CBOR text instead of a map', { raw: Buffer.from([0x63, 0x61, 0x62, 0x63]) }],
    ['an empty attestationObject', { raw: Buffer.alloc(0) }],
  ])('%s → invalid with reason attestation_format, nothing fetched or stored', async (_name, attestation) => {
    const { session, cred } = await signedIn();
    const o = await regOptions('public', session);
    const log = memoryLogger('api');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await verifyRegistration(
        { db: a.db, keys: t.keys, site: SITE, logger: log.logger },
        {
          host: 'public',
          session,
          credential: cred.register({ challenge: o.challenge, attestation }),
          name: undefined,
        },
      );
      expect(result).toEqual({ ok: false, code: 'invalid' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(log.lines().map((l) => [l.msg, l.reason])).toEqual([['passkey_register_refused', 'attestation_format']]);
    expect(await countRows('SELECT count(*) AS n FROM passkey WHERE credential_id = $1', [cred.id])).toBe(0);
    // Nothing was spent: the same challenge with the statement a browser sends (none) still registers.
    const none = cred.register({ challenge: o.challenge });
    expect((await verifyRegistration(wa(), { host: 'public', session, credential: none, name: undefined })).ok).toBe(
      true,
    );
  });

  it.each<'ES256' | 'EdDSA'>(['ES256', 'EdDSA'])(
    'packed self attestation (%s) registers and then signs in',
    async (alg) => {
      const { user, session } = await signedIn();
      const cred = softCredential({ userHandle: await handleOf(user.id), alg });
      const o = await regOptions('public', session);
      const result = await verifyRegistration(wa(), {
        host: 'public',
        session,
        credential: cred.register({ challenge: o.challenge, attestation: 'self' }),
        name: undefined,
      });
      expect(result.ok).toBe(true);
      const p = peer();
      expect((await verify(cred.assert({ challenge: await options({ peer: p }) }), { peer: p })).status).toBe(200);
    },
  );

  it('packed self attestation with a signature that does not verify → invalid (verify)', async () => {
    const { session, cred } = await signedIn();
    const o = await regOptions('public', session);
    const log = memoryLogger('api');
    const attestation: Attestation = {
      fmt: 'packed',
      attStmt: stmt([
        ['alg', -7],
        ['sig', junk(70)],
      ]),
    };
    const result = await verifyRegistration(
      { db: a.db, keys: t.keys, site: SITE, logger: log.logger },
      { host: 'public', session, credential: cred.register({ challenge: o.challenge, attestation }), name: undefined },
    );
    expect(result).toEqual({ ok: false, code: 'invalid' });
    expect(log.lines().map((l) => l.reason)).toEqual(['verify']);
  });

  it('the challenge binds to its host, ceremony, session and expiry, and is spent once', async () => {
    const { user, session, cred } = await signedIn();
    const reg = (challenge: string, s = session, host: 'public' | 'admin' = 'public') =>
      verifyRegistration(wa(), { host, session: s, credential: cred.register({ challenge }), name: undefined });
    const invalid = { ok: false, code: 'invalid' };
    // a sign-in challenge
    expect(await reg(signInOptions(wa(), 'public').challenge)).toEqual(invalid);
    // another session of the same member, and another member
    const otherToken = (await startSession(a.db, { userId: user.id, host: 'public', method: 'code', sentToken: null }))
      .token;
    const otherSession = await loadSession(a.db, otherToken, 'public');
    expect(await reg((await regOptions('public', otherSession as NonNullable<typeof otherSession>)).challenge)).toEqual(
      invalid,
    );
    const stranger = await signedIn();
    expect(await reg((await regOptions('public', stranger.session)).challenge)).toEqual(invalid);
    // the admin host's challenge on the public host
    const admin = await signedIn('admin');
    expect(await reg((await regOptions('admin', admin.session)).challenge, admin.session, 'public')).toEqual(invalid);
    // expired by the process clock
    const old = mintChallenge(t.keys, 'public', 'register', [user.id, session.ref], Date.now() / 1_000 - 301);
    expect(await reg(old.toString('base64url'))).toEqual(invalid);
    // spent once: the second credential on the same challenge is refused
    const o = await regOptions('public', session);
    expect((await reg(o.challenge)).ok).toBe(true);
    const second = softCredential({ userHandle: await handleOf(user.id) });
    expect(
      await verifyRegistration(wa(), {
        host: 'public',
        session,
        credential: second.register({ challenge: o.challenge }),
        name: undefined,
      }),
    ).toEqual(invalid);
  });

  it('on the admin host: the admin origin registers, the public origin does not', async () => {
    const { session, cred } = await signedIn('admin');
    const bad = await verifyRegistration(wa(), {
      host: 'admin',
      session,
      credential: cred.register({ challenge: (await regOptions('admin', session)).challenge, origin: PUBLIC_ORIGIN }),
      name: undefined,
    });
    expect(bad).toEqual({ ok: false, code: 'invalid' });
    const good = await verifyRegistration(wa(), {
      host: 'admin',
      session,
      credential: cred.register({ challenge: (await regOptions('admin', session)).challenge, origin: ADMIN_ORIGIN }),
      name: undefined,
    });
    expect(good.ok).toBe(true);
  });

  it('an id that is not the one in the authenticator data → invalid', async () => {
    const { session, cred } = await signedIn();
    const att = cred.register({ challenge: (await regOptions('public', session)).challenge });
    const other = Buffer.alloc(16, 5).toString('base64url');
    const result = await verifyRegistration(wa(), {
      host: 'public',
      session,
      credential: { ...att, id: other, rawId: other },
      name: undefined,
    });
    expect(result).toEqual({ ok: false, code: 'invalid' });
  });

  it('a credential id another member already holds → conflict, and theirs stays theirs', async () => {
    const first = await signedIn();
    const second = await signedIn();
    expect(
      (
        await verifyRegistration(wa(), {
          host: 'public',
          session: first.session,
          credential: first.cred.register({ challenge: (await regOptions('public', first.session)).challenge }),
          name: undefined,
        })
      ).ok,
    ).toBe(true);
    const squat = softCredential({ userHandle: await handleOf(second.user.id), id: first.cred.id });
    const result = await verifyRegistration(wa(), {
      host: 'public',
      session: second.session,
      credential: squat.register({ challenge: (await regOptions('public', second.session)).challenge }),
      name: undefined,
    });
    expect(result).toEqual({ ok: false, code: 'conflict' });
    expect(
      (await a.admin.query('SELECT user_id FROM passkey WHERE credential_id = $1', [first.cred.id])).rows[0]?.user_id,
    ).toBe(first.user.id);
  });

  it('the 21st passkey → conflict at options and at verify, also when two race', async () => {
    const { user, session } = await signedIn();
    const handle = await handleOf(user.id);
    for (let i = 0; i < 19; i++) await store(user.id, softCredential({ userHandle: handle }));
    // two registrations racing for the 20th place
    const [x, y] = [softCredential({ userHandle: handle }), softCredential({ userHandle: handle })];
    const [ox, oy] = [await regOptions('public', session), await regOptions('public', session)];
    const results = await Promise.all([
      verifyRegistration(wa(), {
        host: 'public',
        session,
        credential: x.register({ challenge: ox.challenge }),
        name: undefined,
      }),
      verifyRegistration(wa(), {
        host: 'public',
        session,
        credential: y.register({ challenge: oy.challenge }),
        name: undefined,
      }),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['conflict', 'ok']);
    expect(await countRows('SELECT count(*) AS n FROM passkey WHERE user_id = $1', [user.id])).toBe(20);
    expect(await registrationOptions(wa(), 'public', session)).toEqual({ ok: false, code: 'conflict' });
  });

  it('logs fixed codes only', () => {
    const text = JSON.stringify(lines());
    expect(lines().length).toBeGreaterThan(5);
    for (const l of lines()) {
      expect(l.msg).toBe('passkey_register_refused');
      expect(String(l.reason)).toMatch(/^[a-z_]{1,40}$/);
    }
    expect(text).not.toMatch(/@example\.org/);
  });
});
