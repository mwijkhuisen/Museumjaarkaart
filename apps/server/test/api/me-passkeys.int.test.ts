import { Me, PasskeyItem, PasskeyList, PasskeyRegistrationOptions } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSession, startSession } from '../../src/auth/session.ts';
import { accountsApp, altchaPayload, codeFor, SITE, tokenOf } from '../auth/app.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { type SoftCredential, softCredential } from '../auth/soft-authenticator.ts';

// P2b criteria 4 and 5 (issue #18) over HTTP, with credentials made by a software authenticator:
//   4  adding a passkey needs a sign-in within 5 minutes at the options and within 10 at the end,
//      removing one needs 10; a fresh code makes all three work again; a removal ends every other
//      session of the member and leaves other members' alone
//   5  a deleted passkey stops working at once; another member's ref is a 404, never a 403
// The routes run over accountsApp (x-test-access stands in for the Access JWT on the admin host).

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

const PUBLIC_ORIGIN = 'https://mjk.test';
const ADMIN_ORIGIN = 'https://admin.mjk.test';
let n = 0;
/** A /24 of its own for each member, so the limiter's buckets never meet. */
const peer = () => `198.19.${++n}.9`;

type Host = 'public' | 'admin';
type Who = {
  user: { id: string; email: string; handle: string };
  token: string;
  cred: SoftCredential;
  host: Host;
  peer: string;
};

const hostName = (h: Host) => (h === 'admin' ? SITE.adminHost : SITE.domain);
const originOf = (h: Host) => (h === 'admin' ? ADMIN_ORIGIN : PUBLIC_ORIGIN);

const handleOf = async (userId: string): Promise<Buffer> =>
  (await a.admin.query<{ h: Buffer }>('SELECT webauthn_user_id AS h FROM app_user WHERE id = $1', [userId])).rows[0]
    ?.h as Buffer;

async function member(host: Host = 'public'): Promise<Who> {
  const user = await a.newUser();
  const token = (await startSession(a.db, { userId: user.id, host, method: 'code', sentToken: null })).token;
  return { user, token, host, peer: peer(), cred: softCredential({ userHandle: await handleOf(user.id) }) };
}

/** One request as `w`; `token: null` sends no cookie, a string sends that session instead. */
function call(w: Who, path: string, o: { method?: string; body?: unknown; token?: string | null } = {}) {
  const token = o.token === undefined ? w.token : o.token;
  return t.req(path, {
    host: hostName(w.host),
    peer: w.peer,
    ...(o.method === undefined ? {} : { method: o.method }),
    ...(o.body === undefined ? {} : { body: o.body }),
    ...(token === null ? {} : { cookie: token }),
    ...(w.host === 'admin' ? { headers: { 'x-test-access': w.user.email } } : {}),
  });
}

const optionsOf = (w: Who, o: { token?: string | null } = {}) =>
  call(w, '/me/passkeys/options', { method: 'POST', ...o });

async function challengeOf(w: Who, token?: string | null): Promise<string> {
  const r = await optionsOf(w, token === undefined ? {} : { token });
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return PasskeyRegistrationOptions.parse(await r.json()).challenge;
}

/** Options, then the credential made for them, then POST /me/passkeys. */
async function add(
  w: Who,
  o: {
    cred?: SoftCredential;
    name?: string;
    forged?: Partial<Omit<Parameters<SoftCredential['register']>[0], 'challenge'>>;
    token?: string | null;
  } = {},
) {
  const challenge = await challengeOf(w, o.token);
  const credential = (o.cred ?? w.cred).register({ challenge, origin: originOf(w.host), ...(o.forged ?? {}) });
  return call(w, '/me/passkeys', {
    body: { credential, ...(o.name === undefined ? {} : { name: o.name }) },
    ...(o.token === undefined ? {} : { token: o.token }),
  });
}

async function added(w: Who, name?: string, cred?: SoftCredential) {
  const r = await add(w, { ...(name === undefined ? {} : { name }), ...(cred === undefined ? {} : { cred }) });
  expect(r.status).toBe(201);
  return PasskeyItem.parse(await r.json());
}

const backdate = (w: Who, minutes: number) =>
  a.admin.query('UPDATE session SET reauth_at = now() - make_interval(mins => $2::int) WHERE user_id = $1', [
    w.user.id,
    minutes,
  ]);

const count = async (sql: string, params: unknown[]) =>
  Number((await a.admin.query<{ n: string }>(sql, params)).rows[0]?.n);
const passkeysOf = (w: Who) => count('SELECT count(*) AS n FROM passkey WHERE user_id = $1', [w.user.id]);

const listOf = async (w: Who) => {
  const r = await call(w, '/me/passkeys');
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return { text: await r.clone().text(), list: PasskeyList.parse(await r.json()) };
};

/** A sign-in with the passkey through the public routes, on the member's host. */
async function signInWithPasskey(w: Who, cred: SoftCredential) {
  const headers = w.host === 'admin' ? { 'x-test-access': w.user.email } : {};
  const o = await t.req('/auth/passkey/options', { method: 'POST', host: hostName(w.host), peer: w.peer, headers });
  expect(o.status).toBe(200);
  const { challenge } = (await o.json()) as { challenge: string };
  return t.req('/auth/passkey/verify', {
    body: { credential: cred.assert({ challenge, origin: originOf(w.host) }) },
    host: hostName(w.host),
    peer: w.peer,
    headers,
  });
}

const sessionLoads = async (w: Who, token: string) =>
  ((await (await call(w, '/me', { token })).json()) as { user: unknown }).user !== null;

describe('the whole flow over HTTP', () => {
  it.each<Host>(['public', 'admin'])(
    'on the %s host: options, add, list, sign in with it, list again',
    async (host) => {
      const w = await member(host);
      const empty = await call(w, '/me/passkeys');
      expect(await empty.text()).toBe('{"items":[]}');
      expect(empty.headers.get('cache-control')).toBe('private, no-store');

      const challenge = await challengeOf(w);
      const reg = await call(w, '/me/passkeys', {
        body: { credential: w.cred.register({ challenge, origin: originOf(host), backedUp: true }), name: 'Laptop' },
      });
      expect(reg.status).toBe(201);
      expect(reg.headers.get('cache-control')).toBe('private, no-store');
      const item = PasskeyItem.parse(await reg.json());
      expect(item).toMatchObject({ name: 'Laptop', backed_up: true, last_used_at: null });

      const first = await listOf(w);
      expect(first.list.items).toEqual([item]);

      const signed = await signInWithPasskey(w, w.cred);
      expect(signed.status).toBe(200);
      expect(Me.parse(await signed.json()).user?.handle).toBe(w.user.handle);
      expect(tokenOf(signed)).not.toBeNull();

      const second = (await listOf(w)).list.items[0];
      expect(second?.ref).toBe(item.ref);
      expect(second?.last_used_at).not.toBeNull();
    },
  );

  it('lists newest first and never a key, a credential id, the transports or the counter', async () => {
    const w = await member();
    const one = await added(w, 'First');
    const other = softCredential({ userHandle: w.cred.userHandle });
    const two = await added(w, 'Second', other);
    const { list, text } = await listOf(w);
    expect(list.items.map((i) => i.ref)).toEqual([two.ref, one.ref]);
    for (const c of [w.cred, other]) {
      for (const secret of [
        c.id.toString('base64url'),
        c.id.toString('hex'),
        c.publicKeyCose.toString('base64url'),
        c.publicKeyCose.toString('hex'),
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    for (const word of ['credential', 'public_key', 'sign_count', 'transports', 'internal']) {
      expect(text).not.toContain(word);
    }
  });

  it('rename: 200 with the trimmed name, the row is the member’s own', async () => {
    const w = await member();
    const item = await added(w, 'Old');
    const r = await call(w, `/me/passkeys/${item.ref}`, { method: 'PATCH', body: { name: '  Phone  ' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(PasskeyItem.parse(await r.json())).toEqual({ ...item, name: 'Phone' });
    expect((await listOf(w)).list.items[0]?.name).toBe('Phone');
  });
});

describe('criterion 4: re-authentication', () => {
  it('options need a sign-in within 5 minutes: 6 minutes → 403 reauth_required, 4 → 200', async () => {
    const w = await member();
    await backdate(w, 6);
    const stale = await optionsOf(w);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth_required' });
    expect(stale.headers.get('cache-control')).toBe('private, no-store');
    await backdate(w, 4);
    expect((await optionsOf(w)).status).toBe(200);
  });

  it('adding ends within 10 minutes: 11 → 403 reauth_required and nothing stored, 9 → 201', async () => {
    const w = await member();
    const challenge = await challengeOf(w);
    const credential = w.cred.register({ challenge });
    await backdate(w, 11);
    const stale = await call(w, '/me/passkeys', { body: { credential } });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth_required' });
    expect(await passkeysOf(w)).toBe(0);
    // The check runs before the body is read, so the challenge is unspent: 9 minutes later it still works.
    await backdate(w, 9);
    expect((await call(w, '/me/passkeys', { body: { credential } })).status).toBe(201);
    expect(await passkeysOf(w)).toBe(1);
  });

  it('removing needs a sign-in within 10 minutes: 11 → 403 and the passkey stays, 9 → 204', async () => {
    const w = await member();
    const item = await added(w, 'Keep');
    await backdate(w, 11);
    const stale = await call(w, `/me/passkeys/${item.ref}`, { method: 'DELETE' });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth_required' });
    expect(await passkeysOf(w)).toBe(1);
    await backdate(w, 9);
    const gone = await call(w, `/me/passkeys/${item.ref}`, { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expect(gone.headers.get('cache-control')).toBe('private, no-store');
    expect(await gone.text()).toBe('');
    expect(await passkeysOf(w)).toBe(0);
  });

  it('a fresh code makes the options, the add and the removal work again', async () => {
    const w = await member();
    const old = await added(w, 'Before');
    await backdate(w, 11);
    expect((await optionsOf(w)).status).toBe(403);
    expect((await call(w, `/me/passkeys/${old.ref}`, { method: 'DELETE' })).status).toBe(403);

    // A real sign-in by code: a new session, fresh by its own sign-in.
    const requested = await t.req('/auth/code', {
      body: { email: w.user.email, purpose: 'signin', altcha: await altchaPayload(t.req), locale: 'en' },
      peer: w.peer,
    });
    expect(requested.status).toBe(202);
    const code = await codeFor(a, t.keys, w.user.email, 'signin');
    const verified = await t.req('/auth/code/verify', {
      body: { email: w.user.email, purpose: 'signin', code },
      peer: w.peer,
    });
    expect(verified.status).toBe(200);
    const fresh = tokenOf(verified) as string;
    expect(fresh).not.toBe(w.token);

    const second = softCredential({ userHandle: w.cred.userHandle });
    expect((await add(w, { cred: second, token: fresh, name: 'After' })).status).toBe(201);
    expect((await call(w, `/me/passkeys/${old.ref}`, { method: 'DELETE', token: fresh })).status).toBe(204);
    expect(await passkeysOf(w)).toBe(1);
  });

  it('removing ends every other session of the member, keeps this one and leaves other members alone', async () => {
    const w = await member();
    const second = (await startSession(a.db, { userId: w.user.id, host: 'public', method: 'code', sentToken: null }))
      .token;
    const third = (await startSession(a.db, { userId: w.user.id, host: 'public', method: 'code', sentToken: null }))
      .token;
    const bystander = await member();
    const item = await added(w, 'Lost phone');
    expect(await sessionLoads(w, w.token)).toBe(true);
    expect(await sessionLoads(w, second)).toBe(true);
    expect(await sessionLoads(w, third)).toBe(true);

    expect((await call(w, `/me/passkeys/${item.ref}`, { method: 'DELETE', token: second })).status).toBe(204);
    expect(await sessionLoads(w, second)).toBe(true);
    expect(await sessionLoads(w, w.token)).toBe(false);
    expect(await sessionLoads(w, third)).toBe(false);
    expect(await sessionLoads(bystander, bystander.token)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM session WHERE user_id = $1', [w.user.id])).toBe(1);
  });
});

describe('criterion 5: a removed passkey, and other members’ rows', () => {
  it('a deleted passkey stops working at once: an assertion made before the removal is a 401 after it', async () => {
    const w = await member();
    const item = await added(w, 'Doomed');
    // Made while the passkey exists, sent only after the removal.
    const o = await t.req('/auth/passkey/options', { method: 'POST', peer: w.peer });
    const { challenge } = (await o.json()) as { challenge: string };
    const assertion = w.cred.assert({ challenge });
    expect((await call(w, `/me/passkeys/${item.ref}`, { method: 'DELETE' })).status).toBe(204);
    const r = await t.req('/auth/passkey/verify', { body: { credential: assertion }, peer: w.peer });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
    expect(tokenOf(r)).toBeNull();
  });

  it('another member’s ref is a 404 on PATCH and DELETE, never a 403, and their row and sessions are unchanged', async () => {
    const alice = await member();
    const bob = await member();
    const bobItem = await added(bob, 'Bob’s key');
    const aliceSecond = (
      await startSession(a.db, { userId: alice.user.id, host: 'public', method: 'code', sentToken: null })
    ).token;

    const patch = await call(alice, `/me/passkeys/${bobItem.ref}`, { method: 'PATCH', body: { name: 'Mine now' } });
    expect(patch.status).toBe(404);
    expect(await patch.json()).toEqual({ error: 'not_found' });
    const del = await call(alice, `/me/passkeys/${bobItem.ref}`, { method: 'DELETE' });
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual({ error: 'not_found' });

    expect((await listOf(bob)).list.items).toEqual([bobItem]);
    expect(await passkeysOf(alice)).toBe(0);
    // The refused removal ended no session of Alice's.
    expect(await sessionLoads(alice, aliceSecond)).toBe(true);
    // An unknown ref is the same 404.
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await call(alice, `/me/passkeys/${unknown}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    expect((await call(alice, `/me/passkeys/${unknown}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('refusals', () => {
  it('a forged credential → 422 invalid on `response`, nothing stored', async () => {
    const w = await member();
    for (const forged of [{ origin: 'https://evil.test' }, { rpId: 'evil.test' }, { uv: false }]) {
      const r = await add(w, { forged });
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields: ['response'] });
    }
    // A challenge that was never ours.
    const credential = w.cred.register({ challenge: Buffer.alloc(54, 7).toString('base64url') });
    const r = await call(w, '/me/passkeys', { body: { credential } });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['response'] });
    expect(await passkeysOf(w)).toBe(0);
  });

  it('10 failed adds an hour per member, then 429 (L2); a stored passkey gives its slot back', async () => {
    const w = await member();
    const forged = { origin: 'https://evil.test' };
    for (let i = 0; i < 9; i++) expect((await add(w, { forged })).status).toBe(422);
    // Successes do not count: the 10th failure is still a 422.
    await added(w, 'First');
    await added(w, 'Second', softCredential({ userHandle: w.cred.userHandle }));
    expect((await add(w, { forged })).status).toBe(422);
    const from = t.lines().length;
    // The 11th failed attempt is refused before any verify, so a good credential is refused too.
    const r = await add(w, { cred: softCredential({ userHandle: w.cred.userHandle }) });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await passkeysOf(w)).toBe(2);
    const limited = t
      .lines()
      .slice(from)
      .filter((l) => l.msg === 'rate_limited');
    expect(limited.map((l) => l.bucket)).toEqual(['passkey_register_user']);
    expect(JSON.stringify(t.lines().slice(from))).not.toContain(w.user.id);
    // Another member is not affected.
    const other = await member();
    expect((await add(other)).status).toBe(201);
  });

  it('the same credential twice → 409', async () => {
    const w = await member();
    await added(w, 'Once');
    const again = await add(w, { name: 'Twice' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'conflict' });
    expect(await passkeysOf(w)).toBe(1);
  });

  it('the 21st → 409 at the options', async () => {
    const w = await member();
    await a.admin.query(
      `INSERT INTO passkey (credential_id, user_id, public_key, backed_up)
       SELECT uuid_send(gen_random_uuid()), $1, uuid_send(gen_random_uuid()), false FROM generate_series(1, 20)`,
      [w.user.id],
    );
    const r = await optionsOf(w);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'conflict' });
    expect((await listOf(w)).list.items).toHaveLength(20);
  });

  it('a bad name, an unknown key, a bad ref, a query string or no body → 400', async () => {
    const w = await member();
    const item = await added(w, 'Fine');
    const patch = (ref: string, body?: unknown) =>
      call(w, `/me/passkeys/${ref}`, { method: 'PATCH', ...(body === undefined ? {} : { body }) });
    for (const name of ['bad\u0007name', 'bidi‮name', 'line break', 'x'.repeat(51), '', '   ']) {
      expect((await patch(item.ref, { name })).status, JSON.stringify(name)).toBe(400);
    }
    expect((await patch(item.ref, { name: 'ok', extra: 1 })).status).toBe(400);
    expect((await patch(item.ref, {})).status).toBe(400);
    expect((await patch(item.ref)).status).toBe(400);
    expect((await patch('not-a-uuid', { name: 'ok' })).status).toBe(400);
    expect((await call(w, '/me/passkeys/not-a-uuid', { method: 'DELETE' })).status).toBe(400);
    expect((await call(w, '/me/passkeys/options?x=1', { method: 'POST' })).status).toBe(400);
    // 50 code points, and an astral one, are fine.
    expect((await patch(item.ref, { name: '𝄞'.repeat(50) })).status).toBe(200);
    // An unknown key on the register request, and a missing credential.
    const credential = w.cred.register({ challenge: await challengeOf(w) });
    expect((await call(w, '/me/passkeys', { body: { credential, extra: true } })).status).toBe(400);
    expect((await call(w, '/me/passkeys', { body: { name: 'x' } })).status).toBe(400);
    expect((await call(w, '/me/passkeys', { method: 'POST' })).status).toBe(400);
    expect((await listOf(w)).list.items[0]?.name).toBe('𝄞'.repeat(50));
  });

  it('signed out → 401 on all five routes', async () => {
    const w = await member();
    const item = await added(w, 'Mine');
    const anon = async (path: string, method: string, body?: unknown) => {
      const r = await call(w, path, { method, token: null, ...(body === undefined ? {} : { body }) });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    };
    await anon('/me/passkeys', 'GET');
    await anon('/me/passkeys/options', 'POST');
    await anon('/me/passkeys', 'POST', { credential: w.cred.register({ challenge: await challengeOf(w) }) });
    await anon(`/me/passkeys/${item.ref}`, 'PATCH', { name: 'x' });
    await anon(`/me/passkeys/${item.ref}`, 'DELETE');
    expect((await listOf(w)).list.items).toEqual([item]);
  });

  it('a session of the other host class is no session here', async () => {
    const w = await member('public');
    const onAdmin: Who = { ...w, host: 'admin' };
    expect((await call(onAdmin, '/me/passkeys')).status).toBe(401);
    expect(await loadSession(a.db, w.token, 'admin')).toBeNull();
  });
});
