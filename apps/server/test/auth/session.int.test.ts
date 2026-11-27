import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiEnv } from '../../src/api/middleware/request.ts';
import { sessionMiddleware } from '../../src/api/middleware/session.ts';
import {
  CLEAR_COOKIE,
  endUserSessions,
  LIFETIME,
  loadSession,
  readSessionCookie,
  requireReauth,
  SESSION_COOKIE,
  sessionCookie,
  startSession,
} from '../../src/auth/session.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';

// Criterion 4 (A§9, ADR-0007): the cookie's exact attributes, only sha256(token) stored, idle,
// sliding and absolute expiry on both hosts, a sign-in deleting the sent cookie's row, host binding,
// a ban (status) ending the session, and re-authentication. The clock is the database's: rows are
// backdated through the superuser.

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
}, 120_000);
afterAll(async () => {
  await a?.close();
});

const rowOf = async (token: string) => {
  const id = createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
  const r = await a.admin.query(
    `SELECT host, method, extract(epoch from expires_at - created_at) AS idle_s,
            extract(epoch from absolute_expires_at - created_at) AS abs_s,
            extract(epoch from expires_at - now()) AS left_s, last_used_at
     FROM session WHERE id = $1`,
    [id],
  );
  return { id, row: r.rows[0] as Record<string, unknown> | undefined };
};

describe('the cookie', () => {
  it('has exactly A§9 attributes plus Max-Age, and a clearing twin', () => {
    const token = 'A'.repeat(43);
    expect(sessionCookie(token, 'public')).toBe(
      `__Host-mjk_sid=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${180 * 86_400}`,
    );
    expect(sessionCookie(token, 'admin')).toBe(
      `__Host-mjk_sid=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${7 * 86_400}`,
    );
    expect(CLEAR_COOKIE).toBe('__Host-mjk_sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });

  it('is read from a Cookie header by its exact name only', () => {
    expect(readSessionCookie(`a=1; ${SESSION_COOKIE}=tok; b=2`)).toBe('tok');
    expect(readSessionCookie('mjk_sid=tok; __Host-mjk_sidx=tok')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=${'x'.repeat(9_000)}`)).toBeNull();
  });
});

describe('sessions in the database', () => {
  it('stores only sha256 of the token; the lifetimes per host', async () => {
    const u = await a.newUser();
    const pub = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const adm = await startSession(a.db, { userId: u.id, host: 'admin', method: 'password', sentToken: null });
    const p = await rowOf(pub.token);
    const q = await rowOf(adm.token);
    expect(p.row).toMatchObject({ host: 'public', method: 'code' });
    expect(Number(p.row?.idle_s)).toBeCloseTo(LIFETIME.public.idleS, -1);
    expect(Number(p.row?.abs_s)).toBeCloseTo(LIFETIME.public.absoluteS, -1);
    expect(Number(q.row?.idle_s)).toBeCloseTo(12 * 3_600, -1);
    expect(Number(q.row?.abs_s)).toBeCloseTo(7 * 86_400, -1);
    // No column of any session row holds the token in any spelling.
    const all = await a.admin.query("SELECT row_to_json(s)::text AS j, encode(id, 'hex') AS hex FROM session s");
    for (const r of all.rows as { j: string; hex: string }[]) {
      expect(r.j).not.toContain(pub.token);
      expect(r.j).not.toContain(adm.token);
    }
    expect((all.rows as { hex: string }[]).map((r) => r.hex)).toContain(p.id.toString('hex'));
  });

  it('works only on its own host, and only while the user is active', async () => {
    const u = await a.newUser();
    const s = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    expect((await loadSession(a.db, s.token, 'public'))?.user.id).toBe(u.id);
    expect(await loadSession(a.db, s.token, 'admin')).toBeNull();
    await a.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [u.id]);
    expect(await loadSession(a.db, s.token, 'public')).toBeNull();
    expect(await loadSession(a.db, 'not-a-token', 'public')).toBeNull();
  });

  it('an idle session ends; an active one slides, never past its absolute lifetime', async () => {
    const u = await a.newUser();
    const s = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const { id } = await rowOf(s.token);
    // Idle past expires_at → gone.
    await a.admin.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await loadSession(a.db, s.token, 'public')).toBeNull();
    // Active: last used two hours ago, a day left → slides to now + 30 days.
    await a.admin.query(
      `UPDATE session SET created_at = now() - interval '40 days', last_used_at = now() - interval '2 hours',
         expires_at = now() + interval '1 day' WHERE id = $1`,
      [id],
    );
    expect(await loadSession(a.db, s.token, 'public')).not.toBeNull();
    const slid = await rowOf(s.token);
    expect(Number(slid.row?.left_s)).toBeCloseTo(LIFETIME.public.idleS, -2);
    // A touch at most once an hour: a second load within the hour writes nothing.
    const before = slid.row?.last_used_at;
    await loadSession(a.db, s.token, 'public');
    expect((await rowOf(s.token)).row?.last_used_at).toEqual(before);
    // Near the absolute end, the slide stops at it; past it, the session is gone.
    await a.admin.query(
      `UPDATE session SET last_used_at = now() - interval '2 hours', absolute_expires_at = now() + interval '1 minute',
         expires_at = now() + interval '30 seconds' WHERE id = $1`,
      [id],
    );
    expect(await loadSession(a.db, s.token, 'public')).not.toBeNull();
    expect(Number((await rowOf(s.token)).row?.left_s)).toBeLessThanOrEqual(61);
    await a.admin.query(
      "UPDATE session SET absolute_expires_at = now() - interval '1 second', expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    expect(await loadSession(a.db, s.token, 'public')).toBeNull();
  });

  it('an admin-host session ends after 12 h idle', async () => {
    const u = await a.newUser();
    const s = await startSession(a.db, { userId: u.id, host: 'admin', method: 'code', sentToken: null });
    const { id } = await rowOf(s.token);
    await a.admin.query(
      "UPDATE session SET last_used_at = now() - interval '12 hours 1 minute', expires_at = now() - interval '1 minute' WHERE id = $1",
      [id],
    );
    expect(await loadSession(a.db, s.token, 'admin')).toBeNull();
  });

  it('signing in deletes the row of the cookie sent with it, and issues a new token', async () => {
    const u = await a.newUser();
    const old = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const next = await startSession(a.db, { userId: u.id, host: 'public', method: 'password', sentToken: old.token });
    expect(next.token).not.toBe(old.token);
    expect((await rowOf(old.token)).row).toBeUndefined();
    expect((await rowOf(next.token)).row).toBeDefined();
  });

  it('ends every session, or every other one', async () => {
    const u = await a.newUser();
    const s1 = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const s2 = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const s3 = await startSession(a.db, { userId: u.id, host: 'admin', method: 'code', sentToken: null });
    await endUserSessions(a.db, u.id, (await rowOf(s1.token)).id);
    expect((await rowOf(s1.token)).row).toBeDefined();
    expect((await rowOf(s2.token)).row).toBeUndefined();
    expect((await rowOf(s3.token)).row).toBeUndefined();
    await endUserSessions(a.db, u.id);
    expect((await rowOf(s1.token)).row).toBeUndefined();
  });

  it('requires a sign-in or code within the last 10 minutes for a sensitive change', async () => {
    const u = await a.newUser();
    const s = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const fresh = await loadSession(a.db, s.token, 'public');
    expect(() => requireReauth(fresh as NonNullable<typeof fresh>)).not.toThrow();
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '11 minutes' WHERE id = $1", [
      (await rowOf(s.token)).id,
    ]);
    const stale = await loadSession(a.db, s.token, 'public');
    expect(() => requireReauth(stale as NonNullable<typeof stale>)).toThrow('reauth_required');
  });
});

describe('the session middleware', () => {
  const site = { domain: 'mjk.test', adminHost: 'admin.mjk.test' };
  const app = (email?: string) => {
    const h = new Hono<ApiEnv>();
    h.use('*', async (c, next) => {
      if (email !== undefined) c.set('access', { email });
      await next();
    });
    h.use('*', sessionMiddleware(a.db, site));
    h.get('/who', (c) => c.json({ user: c.var.session?.user.id ?? null, mismatch: c.var.adminMismatch === true }));
    return h;
  };
  const who = async (h: Hono<ApiEnv>, host: string, token: string) =>
    (await h.request('http://x/who', { headers: { host, cookie: `${SESSION_COOKIE}=${token}` } })).json();

  it('a public-host cookie never counts on the admin host, nor the other way round', async () => {
    const u = await a.newUser();
    const pub = await startSession(a.db, { userId: u.id, host: 'public', method: 'code', sentToken: null });
    const adm = await startSession(a.db, { userId: u.id, host: 'admin', method: 'code', sentToken: null });
    expect(await who(app(), 'mjk.test', pub.token)).toEqual({ user: u.id, mismatch: false });
    expect(await who(app(u.email), 'admin.mjk.test', pub.token)).toEqual({ user: null, mismatch: false });
    expect(await who(app(), 'mjk.test', adm.token)).toEqual({ user: null, mismatch: false });
    expect(await who(app(u.email.toUpperCase()), 'admin.mjk.test', adm.token)).toEqual({ user: u.id, mismatch: false });
  });

  it('on the admin host, a session of another email than the JWT is no session, flagged for the 403', async () => {
    const u = await a.newUser();
    const adm = await startSession(a.db, { userId: u.id, host: 'admin', method: 'code', sentToken: null });
    expect(await who(app('someone.else@example.org'), 'admin.mjk.test', adm.token)).toEqual({
      user: null,
      mismatch: true,
    });
  });
});
