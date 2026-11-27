import { Me, PasskeyReauthOptions, PasskeySignInOptions } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSession, startSession } from '../../src/auth/session.ts';
import { mintChallenge } from '../../src/auth/webauthn.ts';
import { accountsApp, tokenOf } from './app.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';
import { type SoftCredential, softCredential } from './soft-authenticator.ts';

// Re-authentication with a passkey (P2b, owner 2026-11-27): POST /auth/passkey/reauth/options and
// /auth/passkey/reauth/verify. The member confirms it is them with one of their own passkeys; a
// re-authentication never switches accounts and never works for another member, session or host.

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
const peer = () => `198.19.${++n}.7`;
const ADMIN = 'admin.mjk.test';

const handleOf = async (userId: string): Promise<Buffer> =>
  (await a.admin.query<{ h: Buffer }>('SELECT webauthn_user_id AS h FROM app_user WHERE id = $1', [userId])).rows[0]
    ?.h as Buffer;

async function store(userId: string, cred: SoftCredential, transports = '{internal}') {
  await a.admin.query(
    `INSERT INTO passkey (credential_id, user_id, public_key, sign_count, transports, backed_up)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [cred.id, userId, cred.publicKeyCose, cred.counter, transports],
  );
}

/** A member with one passkey and a signed-in session on `host`. */
async function member(host: 'public' | 'admin' = 'public') {
  const user = await a.newUser();
  const cred = softCredential({ userHandle: await handleOf(user.id) });
  await store(user.id, cred);
  const token = (await startSession(a.db, { userId: user.id, host, method: 'code', sentToken: null })).token;
  return { user, cred, token };
}

type Opts = { host?: string; peer?: string; access?: string; cookie?: string };
const extra = (o: Opts) => ({
  host: o.host ?? 'mjk.test',
  peer: o.peer ?? '192.0.2.1',
  headers: o.access === undefined ? {} : { 'x-test-access': o.access },
  ...(o.cookie === undefined ? {} : { cookie: o.cookie }),
});
const reauthOptions = (o: Opts) => t.req('/auth/passkey/reauth/options', { method: 'POST', ...extra(o) });
const reauthVerify = (credential: unknown, o: Opts) =>
  t.req('/auth/passkey/reauth/verify', { body: { credential }, ...extra(o) });

async function reauthChallenge(o: Opts): Promise<PasskeyReauthOptions> {
  const r = await reauthOptions(o);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return PasskeyReauthOptions.parse(await r.json());
}

const reasons = (from: number) =>
  t
    .lines()
    .slice(from)
    .filter((l) => l.msg === 'passkey_refused')
    .map((l) => String(l.reason));

describe('POST /auth/passkey/reauth/options', () => {
  it('lists exactly the member’s own passkeys, needs user verification, and writes nothing', async () => {
    const m = await member();
    const second = softCredential({ userHandle: await handleOf(m.user.id) });
    await store(m.user.id, second, '{hybrid,usb}');
    const stranger = await member();
    const before = Number((await a.admin.query('SELECT count(*) AS n FROM auth_challenge')).rows[0]?.n);
    const o = await reauthChallenge({ cookie: m.token, peer: peer() });
    expect(o.rpId).toBe('mjk.test');
    expect(o.userVerification).toBe('required');
    expect(o.timeout).toBe(300_000);
    expect(o.allowCredentials).toEqual([
      { id: m.cred.id.toString('base64url'), type: 'public-key', transports: ['internal'] },
      { id: second.id.toString('base64url'), type: 'public-key', transports: ['hybrid', 'usb'] },
    ]);
    expect(JSON.stringify(o)).not.toContain(stranger.cred.id.toString('base64url'));
    expect(Number((await a.admin.query('SELECT count(*) AS n FROM auth_challenge')).rows[0]?.n)).toBe(before);
  });

  it('signed out → 401; a member without a passkey → 409; a query string → 400', async () => {
    expect((await reauthOptions({ peer: peer() })).status).toBe(401);
    const user = await a.newUser();
    const token = (await startSession(a.db, { userId: user.id, host: 'public', method: 'code', sentToken: null }))
      .token;
    const none = await reauthOptions({ cookie: token, peer: peer() });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'conflict' });
    const m = await member();
    expect((await t.req('/auth/passkey/reauth/options?x=1', { method: 'POST', cookie: m.token })).status).toBe(400);
  });
});

describe('POST /auth/passkey/reauth/verify', () => {
  it('confirms the member: a new session for the same account, re-authentication fresh, the old row gone', async () => {
    const m = await member();
    const p = peer();
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '11 minutes' WHERE user_id = $1", [m.user.id]);
    expect((await t.req('/me/passkeys/options', { method: 'POST', cookie: m.token, peer: p })).status).toBe(403);
    const { challenge } = await reauthChallenge({ cookie: m.token, peer: p });
    const r = await reauthVerify(m.cred.assert({ challenge }), { cookie: m.token, peer: p });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json()).user?.handle).toBe(m.user.handle);
    const fresh = tokenOf(r) as string;
    expect(fresh).not.toBe(m.token);
    const s = await loadSession(a.db, fresh, 'public');
    expect(s?.user.id).toBe(m.user.id);
    expect(s?.method).toBe('passkey');
    expect(s?.reauthFresh).toBe(true);
    expect(await loadSession(a.db, m.token, 'public')).toBeNull();
    // the 5-minute start of an add (Q1a) now passes
    expect((await t.req('/me/passkeys/options', { method: 'POST', cookie: fresh, peer: p })).status).toBe(200);
  });

  it('takes an assertion without userHandle (the browser had the list), refuses one naming another user', async () => {
    const m = await member();
    const p = peer();
    const plain = m.cred.assert({ challenge: (await reauthChallenge({ cookie: m.token, peer: p })).challenge });
    const { userHandle: _, ...withoutHandle } = plain.response;
    const ok = await reauthVerify({ ...plain, response: withoutHandle }, { cookie: m.token, peer: p });
    expect(ok.status).toBe(200);
    const token = tokenOf(ok) as string;
    const from = t.lines().length;
    const wrong = m.cred.assert({
      challenge: (await reauthChallenge({ cookie: token, peer: p })).challenge,
      userHandle: Buffer.alloc(16, 7),
    });
    expect((await reauthVerify(wrong, { cookie: token, peer: p })).status).toBe(401);
    expect(reasons(from)).toEqual(['user_handle']);
  });

  it('another member’s passkey never re-authenticates this member, and the session stays as it was', async () => {
    const victim = await member();
    const other = await member();
    const p = peer();
    const { challenge } = await reauthChallenge({ cookie: victim.token, peer: p });
    const from = t.lines().length;
    // A valid signature by the other member's own passkey, on the victim's re-authentication challenge.
    const r = await reauthVerify(other.cred.assert({ challenge }), { cookie: victim.token, peer: p });
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(reasons(from)).toEqual(['other_member']);
    expect((await loadSession(a.db, victim.token, 'public'))?.user.id).toBe(victim.user.id);
    expect((await loadSession(a.db, other.token, 'public'))?.user.id).toBe(other.user.id);
  });

  it('the challenge binds: another session, a sign-in challenge, the other host, a replay → 401', async () => {
    const m = await member();
    const p = peer();
    const second = (await startSession(a.db, { userId: m.user.id, host: 'public', method: 'code', sentToken: null }))
      .token;
    const from = t.lines().length;
    // another session of the same member
    const forSecond = await reauthChallenge({ cookie: second, peer: p });
    expect(
      (await reauthVerify(m.cred.assert({ challenge: forSecond.challenge }), { cookie: m.token, peer: p })).status,
    ).toBe(401);
    // a sign-in challenge on the re-authentication route, and a re-authentication challenge on sign-in
    const signIn = PasskeySignInOptions.parse(
      await (await t.req('/auth/passkey/options', { method: 'POST', peer: p })).json(),
    ).challenge;
    expect((await reauthVerify(m.cred.assert({ challenge: signIn }), { cookie: m.token, peer: p })).status).toBe(401);
    const own = await reauthChallenge({ cookie: m.token, peer: p });
    expect(
      (
        await t.req('/auth/passkey/verify', {
          body: { credential: m.cred.assert({ challenge: own.challenge }) },
          peer: p,
        })
      ).status,
    ).toBe(401);
    // the admin host's challenge kind and binding on the public host
    const adminLike = mintChallenge(t.keys, 'admin', 'reauth', [m.user.id, ''], Date.now() / 1_000).toString(
      'base64url',
    );
    expect((await reauthVerify(m.cred.assert({ challenge: adminLike }), { cookie: m.token, peer: p })).status).toBe(
      401,
    );
    expect(reasons(from)).toEqual(['challenge', 'challenge', 'challenge', 'challenge']);
    // a replay of a good assertion
    const good = m.cred.assert({ challenge: (await reauthChallenge({ cookie: m.token, peer: p })).challenge });
    const first = await reauthVerify(good, { cookie: m.token, peer: p });
    expect(first.status).toBe(200);
    expect((await reauthVerify(good, { cookie: tokenOf(first) as string, peer: p })).status).toBe(401);
  });

  it('signed out → 401, whatever the assertion; an unknown key is a 400', async () => {
    const m = await member();
    const p = peer();
    const { challenge } = await reauthChallenge({ cookie: m.token, peer: p });
    expect((await reauthVerify(m.cred.assert({ challenge }), { peer: p })).status).toBe(401);
    expect(
      (
        await t.req('/auth/passkey/reauth/verify', {
          body: { credential: m.cred.assert({ challenge }), x: 1 },
          cookie: m.token,
          peer: p,
        })
      ).status,
    ).toBe(400);
  });

  it('on the admin host it confirms the JWT’s own member with an admin-host session', async () => {
    const m = await member('admin');
    const p = peer();
    const o = { host: ADMIN, access: m.user.email, cookie: m.token, peer: p };
    const { challenge } = await reauthChallenge(o);
    const r = await reauthVerify(m.cred.assert({ challenge, origin: 'https://admin.mjk.test' }), o);
    expect(r.status).toBe(200);
    expect((await loadSession(a.db, tokenOf(r) as string, 'admin'))?.user.id).toBe(m.user.id);
    // without the JWT's email there is no admin-host session, so no re-authentication either
    expect((await reauthOptions({ host: ADMIN, access: 'someone@example.org', cookie: m.token, peer: p })).status).toBe(
      401,
    );
  });
});
