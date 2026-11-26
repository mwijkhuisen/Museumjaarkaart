import { SessionList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { banUser } from '../../src/auth/ban.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { meApp, SITE } from './me-app.ts';

// A§18: every route has an authorization table test. Here every /me route: signed out, a member, a banned
// member's session, a session of the other host class, and another member's session ref ("self": a 404).

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
}, 120_000);
afterAll(async () => {
  await a?.close();
});

type Route = {
  name: string;
  method: string;
  path: (ref: string) => string;
  body?: unknown;
  /** The status a member gets. */
  member: number;
};

const ROUTES: Route[] = [
  { name: 'GET /me', method: 'GET', path: () => '/me', member: 200 },
  { name: 'PATCH /me', method: 'PATCH', path: () => '/me', body: { settings: { card_type: 'under_19' } }, member: 200 },
  {
    name: 'POST /me/email',
    method: 'POST',
    path: () => '/me/email',
    body: { email: 'authz.new@example.org', locale: 'nl' },
    member: 202,
  },
  // No pending code: the check fails with 401, the same as for an anonymous caller, so it is tested below.
  { name: 'GET /me/sessions', method: 'GET', path: () => '/me/sessions', member: 200 },
  { name: 'DELETE /me/sessions/:ref', method: 'DELETE', path: (ref) => `/me/sessions/${ref}`, member: 204 },
];

describe('the /me authorization table', () => {
  it.each(ROUTES)('$name: anonymous 401 (GET /me answers user:null), member 2xx', async (r) => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.100.7';
    const u = await a.newUser();
    const token = await signIn(u.id);
    // A second session of the same member is the ref a DELETE can remove.
    await signIn(u.id);
    const ref = (
      await a.admin.query('SELECT ref FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.id])
    ).rows[0]?.ref as string;
    const o = { method: r.method, ...(r.body === undefined ? {} : { body: r.body }) };

    const anon = await call(r.path(ref), o);
    if (r.name === 'GET /me') {
      expect(anon.status).toBe(200);
      expect(await anon.text()).toBe('{"user":null}');
    } else {
      expect(anon.status).toBe(401);
      expect(await anon.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await call(r.path(ref), { ...o, token })).status).toBe(r.member);
  });

  it('POST /me/email/verify: anonymous 401, a member without a pending code 401, never a 2xx', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.101.7';
    const u = await a.newUser();
    expect((await call('/me/email/verify', { body: { code: '123456' } })).status).toBe(401);
    expect((await call('/me/email/verify', { token: await signIn(u.id), body: { code: '123456' } })).status).toBe(401);
  });

  it("another member's session ref is a 404, never a 403, and the session survives", async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.102.7';
    const alice = await a.newUser();
    const bob = await a.newUser();
    const aliceToken = await signIn(alice.id);
    await signIn(bob.id);
    const bobRef = (await a.admin.query('SELECT ref FROM session WHERE user_id = $1', [bob.id])).rows[0]?.ref as string;
    const r = await call(`/me/sessions/${bobRef}`, { method: 'DELETE', token: aliceToken });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    expect((await a.admin.query('SELECT 1 FROM session WHERE ref = $1', [bobRef])).rowCount).toBe(1);
    // An unknown ref is the same 404; a malformed one a 400.
    expect(
      (await call('/me/sessions/00000000-0000-4000-8000-000000000000', { method: 'DELETE', token: aliceToken })).status,
    ).toBe(404);
    expect((await call('/me/sessions/not-a-uuid', { method: 'DELETE', token: aliceToken })).status).toBe(400);
  });

  it('DELETE /me/sessions/:ref needs a recent sign-in, and removes only that session', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.103.7';
    const u = await a.newUser();
    const token = await signIn(u.id);
    const other = await signIn(u.id);
    const rows = (
      await a.admin.query('SELECT ref, id FROM session WHERE user_id = $1 ORDER BY created_at, ref', [u.id])
    ).rows;
    const otherRef = rows[1]?.ref as string;
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '11 minutes' WHERE user_id = $1", [u.id]);
    const stale = await call(`/me/sessions/${otherRef}`, { method: 'DELETE', token });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth_required' });
    await a.admin.query('UPDATE session SET reauth_at = now() WHERE user_id = $1', [u.id]);
    expect((await call(`/me/sessions/${otherRef}`, { method: 'DELETE', token })).status).toBe(204);
    expect(await (await call('/me', { token: other })).text()).toBe('{"user":null}');
    expect((await call('/me', { token })).status).toBe(200);
  });

  it('lists the live sessions, newest first, with `current`, and never an id or a token', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.104.7';
    const u = await a.newUser();
    const first = await signIn(u.id);
    const second = await signIn(u.id, 'admin');
    const third = await signIn(u.id);
    // An expired session is not listed.
    await signIn(u.id);
    await a.admin.query(
      "UPDATE session SET expires_at = now() - interval '1 second' WHERE created_at = (SELECT max(created_at) FROM session WHERE user_id = $1)",
      [u.id],
    );
    const r = await call('/me/sessions', { token: third });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const text = await r.text();
    const list = SessionList.parse(JSON.parse(text));
    expect(list.items).toHaveLength(3);
    expect(list.items.map((i) => i.current)).toEqual([true, false, false]);
    expect(list.items.map((i) => i.host)).toEqual(['public', 'admin', 'public']);
    for (const t of [first, second, third]) expect(text).not.toContain(t);
  });

  it("a banned member's session is a 401 on every route", async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.105.7';
    const u = await a.newUser();
    const token = await signIn(u.id);
    // The ban function also deletes the rows; set only the status here, so the check is the status's own.
    await a.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [u.id]);
    expect((await call('/me/sessions', { token })).status).toBe(401);
    expect((await call('/me', { method: 'PATCH', token, body: { settings: { locale: 'en' } } })).status).toBe(401);
    expect(await (await call('/me', { token })).text()).toBe('{"user":null}');
    // And through banUser: the same, with the rows gone.
    const v = await a.newUser();
    const vToken = await signIn(v.id);
    expect(await banUser(a.db, { userId: v.id, until: null, reason: 'test', actorId: null, actorKind: 'system' })).toBe(
      true,
    );
    expect((await call('/me/sessions', { token: vToken })).status).toBe(401);
  });

  it('a public-host session sent to the admin host is no session (and the other way round)', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = '198.51.106.7';
    const u = await a.newUser();
    const pub = await signIn(u.id);
    const adm = await signIn(u.id, 'admin');
    const onAdmin = { host: SITE.adminHost };
    expect(await (await call('/me', { token: pub, ...onAdmin })).text()).toBe('{"user":null}');
    expect((await call('/me/sessions', { token: pub, ...onAdmin })).status).toBe(401);
    // An admin-host session on the public host is no session either.
    expect(await (await call('/me', { token: adm })).text()).toBe('{"user":null}');
  });
});
