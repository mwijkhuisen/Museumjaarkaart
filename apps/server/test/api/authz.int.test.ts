import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeyRegistrationOptions, SessionList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mount } from '../../src/api/app.ts';
import { mountMeExports } from '../../src/api/routes/me-exports.ts';
import { mountMeImports } from '../../src/api/routes/me-imports.ts';
import { mountMeMuseums } from '../../src/api/routes/me-museums.ts';
import { mountMeProgress } from '../../src/api/routes/me-progress.ts';
import { mountMeVisits } from '../../src/api/routes/me-visits.ts';
import { mountMeWishlist } from '../../src/api/routes/me-wishlist.ts';
import { banUser } from '../../src/auth/ban.ts';
import { startSession } from '../../src/auth/session.ts';
import { accountsApp } from '../auth/app.ts';
import { type SoftCredential, softCredential } from '../auth/soft-authenticator.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { meApp, SITE } from './me-app.ts';

// A§18: every route has an authorization table test. Here every /me route: signed out, a member, a banned
// member's session, a session of the other host class, and another member's session ref ("self": a 404).

let a: PassportDb;
beforeAll(async () => {
  a = await openPassportDb();
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

// P2b: the five /me/passkeys routes, over the accounts app (the passkey routes are mounted with the
// auth routes; meApp mounts /me alone). Each row: anonymous, a session of the other host class, a
// member (2xx), another member's ref where a ref is involved (404, never 403), then a banned member.

type PasskeyCtx = { cred: SoftCredential; token: string; challenge: () => Promise<string> };
type PasskeyRoute = {
  name: string;
  method: string;
  path: (ref: string) => string;
  body?: (x: PasskeyCtx) => Promise<unknown>;
  member: number;
  /** The route names a passkey by ref: another member's is a 404. */
  byRef: boolean;
};

const PASSKEY_ROUTES: PasskeyRoute[] = [
  { name: 'GET /me/passkeys', method: 'GET', path: () => '/me/passkeys', member: 200, byRef: false },
  { name: 'POST /me/passkeys/options', method: 'POST', path: () => '/me/passkeys/options', member: 200, byRef: false },
  {
    name: 'POST /me/passkeys',
    method: 'POST',
    path: () => '/me/passkeys',
    body: async (x) => ({ credential: x.cred.register({ challenge: await x.challenge() }), name: 'Authz' }),
    member: 201,
    byRef: false,
  },
  {
    name: 'PATCH /me/passkeys/:ref',
    method: 'PATCH',
    path: (ref) => `/me/passkeys/${ref}`,
    body: async () => ({ name: 'Renamed' }),
    member: 200,
    byRef: true,
  },
  {
    name: 'DELETE /me/passkeys/:ref',
    method: 'DELETE',
    path: (ref) => `/me/passkeys/${ref}`,
    member: 204,
    byRef: true,
  },
];

describe('the /me/passkeys authorization table', () => {
  it.each(PASSKEY_ROUTES)('$name: anonymous 401, other host 401, member $member, banned 401', async (r) => {
    const t = accountsApp(a);
    const peer = `198.51.${110 + PASSKEY_ROUTES.indexOf(r)}.7`;
    const give = async () => {
      const u = await a.newUser();
      const handle = (await a.admin.query('SELECT webauthn_user_id AS h FROM app_user WHERE id = $1', [u.id])).rows[0]
        ?.h as Buffer;
      const cred = softCredential({ userHandle: handle });
      const ref = (
        await a.admin.query(
          'INSERT INTO passkey (credential_id, user_id, public_key, backed_up) VALUES (uuid_send(gen_random_uuid()), $1, $2, false) RETURNING ref',
          [u.id, cred.publicKeyCose],
        )
      ).rows[0]?.ref as string;
      const token = (await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null })).token;
      return { u, cred, ref, token };
    };
    const me = await give();
    const other = await give();
    const send = (path: string, o: { token?: string; body?: unknown; host?: string; access?: string } = {}) =>
      t.req(path, {
        method: r.method,
        peer,
        ...(o.host === undefined ? {} : { host: o.host }),
        ...(o.body === undefined ? {} : { body: o.body }),
        ...(o.token === undefined ? {} : { cookie: o.token }),
        ...(o.access === undefined ? {} : { headers: { 'x-test-access': o.access } }),
      });
    const challenge = async () => {
      const res = await t.req('/me/passkeys/options', { method: 'POST', peer, cookie: me.token });
      return PasskeyRegistrationOptions.parse(await res.json()).challenge;
    };
    const body = r.body === undefined ? undefined : await r.body({ cred: me.cred, token: me.token, challenge });
    const path = r.path(me.ref);

    const anon = await send(path, { body });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'unauthorized' });
    // A public-host session sent to the admin host is no session (the Access identity is the member's own).
    expect((await send(path, { body, token: me.token, host: SITE.adminHost, access: me.u.email })).status).toBe(401);

    if (r.byRef) {
      const foreign = await send(r.path(other.ref), { body, token: me.token });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: 'not_found' });
      expect((await a.admin.query('SELECT 1 FROM passkey WHERE ref = $1 AND name IS NULL', [other.ref])).rowCount).toBe(
        1,
      );
    }

    const ok = await send(path, { body, token: me.token });
    expect(ok.status).toBe(r.member);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');

    // The ban function also deletes the rows; set only the status here, so the check is the status's own.
    await a.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [me.u.id]);
    expect((await send(path, { body, token: me.token })).status).toBe(401);
  });
});

// P2c: the passport's /me routes (A§10), over meApp with the six route files mounted. Each row: signed out
// (401; GET /me/marks answers 200 with null), the member's own resource (2xx), another member's resource
// where the route names one (404, never 403, and the other member's row survives), then a banned member's
// session (401; the marks route reads it as signed out, a 200 with null).

const exportsDir = mkdtempSync(join(tmpdir(), 'mjk-authz-exports-'));
const mountPassport: Mount = (v1, d) => {
  mountMeVisits(v1, d);
  mountMeWishlist(v1, d);
  mountMeMuseums(v1, d);
  mountMeProgress(v1, d);
  mountMeImports(v1, d);
  mountMeExports(v1, { ...d, exportsDir });
};

type Owned = { token: string; visit: string; museumId: string; slug: string; imp: string; exp: string };
type PassportRoute = {
  name: string;
  method: string;
  path: (o: Owned) => string;
  body?: (o: Owned) => unknown;
  member: number;
  /** The route names a row of the member's own: another member's is a 404. */
  foreign?: boolean;
  /** Signed out is a 200 with no data, not a 401. */
  openToAnonymous?: boolean;
};

const PASSPORT_ROUTES: PassportRoute[] = [
  { name: 'GET /me/visits', method: 'GET', path: () => '/me/visits', member: 200 },
  {
    name: 'POST /me/visits',
    method: 'POST',
    path: () => '/me/visits',
    body: (o) => ({ museum_id: o.museumId, visited_on: '2026-01-02' }),
    member: 201,
  },
  {
    name: 'POST /me/visits/bulk',
    method: 'POST',
    path: () => '/me/visits/bulk',
    body: (o) => ({ museum_ids: [o.museumId] }),
    member: 200,
  },
  {
    name: 'PATCH /me/visits/:id',
    method: 'PATCH',
    path: (o) => `/me/visits/${o.visit}`,
    body: () => ({ note: 'changed' }),
    member: 200,
    foreign: true,
  },
  {
    name: 'DELETE /me/visits/:id',
    method: 'DELETE',
    path: (o) => `/me/visits/${o.visit}`,
    member: 204,
    foreign: true,
  },
  { name: 'GET /me/wishlist', method: 'GET', path: () => '/me/wishlist', member: 200 },
  { name: 'PUT /me/wishlist/:museum_id', method: 'PUT', path: (o) => `/me/wishlist/${o.museumId}`, member: 204 },
  { name: 'DELETE /me/wishlist/:museum_id', method: 'DELETE', path: (o) => `/me/wishlist/${o.museumId}`, member: 204 },
  { name: 'GET /me/marks', method: 'GET', path: () => '/me/marks', member: 200, openToAnonymous: true },
  { name: 'GET /me/museums', method: 'GET', path: () => '/me/museums', member: 200 },
  { name: 'GET /me/museums/:slug', method: 'GET', path: (o) => `/me/museums/${o.slug}`, member: 200 },
  { name: 'GET /me/progress', method: 'GET', path: () => '/me/progress', member: 200 },
  {
    name: 'POST /me/imports',
    method: 'POST',
    path: () => '/me/imports',
    body: () => ({ format: 'csv', content: 'museum\nAuthz\n' }),
    member: 201,
  },
  {
    name: 'POST /me/imports/:id/confirm',
    method: 'POST',
    path: (o) => `/me/imports/${o.imp}/confirm`,
    body: () => ({ choose: [], skip: [] }),
    member: 200,
    foreign: true,
  },
  { name: 'POST /me/exports', method: 'POST', path: () => '/me/exports', member: 202 },
  { name: 'GET /me/exports', method: 'GET', path: () => '/me/exports', member: 200 },
  {
    name: 'GET /me/exports/:id/:file',
    method: 'GET',
    path: (o) => `/me/exports/${o.exp}/export.json`,
    member: 200,
    foreign: true,
  },
];

describe('the P2c /me authorization table', () => {
  it.each(PASSPORT_ROUTES)('$name: signed out, member $member, another member 404, banned', async (r) => {
    const { call, signIn, state } = meApp(a, mountPassport);
    state.peer = `198.51.${120 + PASSPORT_ROUTES.indexOf(r)}.7`;
    const museums = [await a.visible(0), await a.visible(1)];
    // One member's rows: a visit, a pending import, a ready export with its file on disk.
    const give = async (n: number) => {
      const u = await a.newMember();
      const museum = museums[n] as { id: string; slug: string };
      const visit = await a.addVisit(u.id, museum.id, { on: '2026-03-01' });
      const imp = (
        await a.owner.query<{ id: string }>(
          `INSERT INTO visit_import (user_id, format, rows) VALUES ($1, 'csv', '[]'::jsonb) RETURNING id`,
          [u.id],
        )
      ).rows[0]?.id as string;
      const exp = (
        await a.owner.query<{ id: string }>(
          `INSERT INTO data_export (user_id, state, expires_at) VALUES ($1, 'ready', now() + interval '1 hour') RETURNING id`,
          [u.id],
        )
      ).rows[0]?.id as string;
      mkdirSync(join(exportsDir, exp));
      writeFileSync(join(exportsDir, exp, 'export.json'), '{}');
      return { u, o: { token: await signIn(u.id), visit, museumId: museum.id, slug: museum.slug, imp, exp } };
    };
    const me = await give(0);
    const other = await give(1);
    const send = (o: Owned, token?: string) => {
      const body = r.body?.(o);
      return call(r.path(o), {
        method: r.method,
        ...(body === undefined ? {} : { body }),
        ...(token === undefined ? {} : { token }),
      });
    };

    const anon = await send(me.o);
    if (r.openToAnonymous) {
      expect(anon.status).toBe(200);
      expect(await anon.json()).toEqual({ marks: null });
    } else {
      expect(anon.status).toBe(401);
      expect(await anon.json()).toEqual({ error: 'unauthorized' });
    }

    if (r.foreign) {
      // The other member's resource, with my session: 404, and theirs is untouched.
      const foreign = await send(other.o, me.o.token);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: 'not_found' });
      const rows = await a.owner.query(
        `SELECT (SELECT count(*) FROM visit WHERE id = $1 AND note IS NULL) AS v,
                (SELECT count(*) FROM visit_import WHERE id = $2 AND state = 'pending') AS i`,
        [other.o.visit, other.o.imp],
      );
      expect(rows.rows[0]).toMatchObject({ v: '1', i: '1' });
    }

    const ok = await send(me.o, me.o.token);
    expect(ok.status).toBe(r.member);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');

    // Only the status is set here, so the check is the status's own.
    await a.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [me.u.id]);
    const banned = await send(me.o, me.o.token);
    if (r.openToAnonymous) {
      expect(banned.status).toBe(200);
      expect(await banned.json()).toEqual({ marks: null });
    } else expect(banned.status).toBe(401);
  });
});
