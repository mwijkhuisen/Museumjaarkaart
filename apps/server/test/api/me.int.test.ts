import { Me } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { meApp } from './me-app.ts';

// GET and PATCH /me (A§10, A§14): signed out is a 200 with `user: null`, a display-name change logs the
// client's address (Q7) and refuses without one, settings merge, bodies are strict.

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('GET /me', () => {
  it('signed out is 200 {"user":null}, private and uncacheable', async () => {
    const { call } = meApp(a);
    const r = await call('/me');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.text()).toBe('{"user":null}');
  });

  it('signed in is the member, as the Me contract', async () => {
    const { call, signIn } = meApp(a);
    const u = await a.newUser();
    const r = await call('/me', { token: await signIn(u.id) });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const me = Me.parse(await r.json());
    expect(me.user).toMatchObject({ handle: u.handle, email: u.email, display_name: 'Member', role: 'user' });
    expect(me.user?.settings.locale).toBe('nl');
  });
});

describe('PATCH /me', () => {
  const ipRows = async (id: string) =>
    (await a.admin.query('SELECT host(ip) AS ip, target_kind, target_id FROM content_ip_log WHERE user_id = $1', [id]))
      .rows as { ip: string; target_kind: string; target_id: string }[];

  it('a new display name is stored and logs the client address once', async () => {
    const { call, signIn } = meApp(a);
    const u = await a.newUser();
    const token = await signIn(u.id);
    const r = await call('/me', { method: 'PATCH', token, body: { display_name: 'Nieuwe Naam' } });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json()).user?.display_name).toBe('Nieuwe Naam');
    expect((await a.admin.query('SELECT display_name FROM app_user WHERE id = $1', [u.id])).rows[0]).toEqual({
      display_name: 'Nieuwe Naam',
    });
    expect(await ipRows(u.id)).toEqual([{ ip: '203.0.113.7', target_kind: 'app_user', target_id: u.id }]);
    // The same name again changes nothing and logs nothing.
    await call('/me', { method: 'PATCH', token, body: { display_name: 'Nieuwe Naam' } });
    expect(await ipRows(u.id)).toHaveLength(1);
  });

  it('settings merge onto what is stored and need no client address', async () => {
    const { call, signIn, state } = meApp(a);
    const u = await a.newUser();
    const token = await signIn(u.id);
    await call('/me', { method: 'PATCH', token, body: { settings: { visits_visibility: 'public' } } });
    state.peer = undefined;
    const r = await call('/me', { method: 'PATCH', token, body: { settings: { locale: 'en' } } });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json()).user?.settings).toEqual({
      visits_visibility: 'public',
      wishlist_visibility: 'private',
      hide_ratings_until_visited: false,
      card_type: 'adult',
      locale: 'en',
    });
    expect(await ipRows(u.id)).toEqual([]);
  });

  it('refuses a display-name change without a client address (429) and writes nothing', async () => {
    const { call, signIn, state, lines } = meApp(a);
    const u = await a.newUser();
    const token = await signIn(u.id);
    state.peer = undefined;
    const r = await call('/me', { method: 'PATCH', token, body: { display_name: 'Anders' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
    expect((await a.admin.query('SELECT display_name FROM app_user WHERE id = $1', [u.id])).rows[0]).toEqual({
      display_name: 'Member',
    });
    expect(lines().some((l) => l.msg === 'rate_limited')).toBe(true);
  });

  it.each([
    ['an unknown key', { display_name: 'Ok', extra: 1 }],
    ['an unknown settings key', { settings: { nope: true } }],
    ['no field at all', {}],
    ['a bidi control in the name', { display_name: 'Ev\u{202E}il' }],
    ['a newline in the name', { display_name: 'two\nlines' }],
    ['an empty name', { display_name: '   ' }],
  ])('%s is a 400', async (_name, body) => {
    const { call, signIn } = meApp(a);
    const u = await a.newUser();
    const r = await call('/me', { method: 'PATCH', token: await signIn(u.id), body });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'bad_request' });
  });

  it('logs no email, code, token or address', async () => {
    const { call, signIn, lines } = meApp(a);
    const u = await a.newUser();
    const token = await signIn(u.id);
    await call('/me', { method: 'PATCH', token, body: { display_name: 'Log Test' } });
    const text = JSON.stringify(lines());
    expect(text).not.toContain(u.email);
    expect(text).not.toContain(token);
    expect(text).not.toContain('203.0.113');
  });
});
