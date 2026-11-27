import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { banUser } from '../../src/auth/ban.ts';
import { loadSession, startSession } from '../../src/auth/session.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';

// Criterion 4 (A§9): a ban revokes every session at once, on both hosts, and leaves an audit row that holds
// codes and ids only, never the reason's text.

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('banUser', () => {
  it('ends every session, sets the status and writes an audit row without the reason', async () => {
    const u = await a.newUser();
    const bystander = await a.newUser();
    const mk = (host: 'public' | 'admin', userId = u.id) =>
      startSession(a.db, { userId, host, method: 'code', sentToken: null });
    const tokens = [(await mk('public')).token, (await mk('public')).token, (await mk('admin')).token];
    const keep = (await mk('public', bystander.id)).token;
    expect(await loadSession(a.db, tokens[2] as string, 'admin')).not.toBeNull();

    const reason = 'harassment of another member, case 4711';
    const until = new Date(Date.now() + 7 * 86_400_000);
    expect(await banUser(a.db, { userId: u.id, until, reason, actorId: bystander.id, actorKind: 'moderator' })).toBe(
      true,
    );

    expect((await a.admin.query('SELECT 1 FROM session WHERE user_id = $1', [u.id])).rowCount).toBe(0);
    expect(await loadSession(a.db, tokens[0] as string, 'public')).toBeNull();
    expect(await loadSession(a.db, tokens[1] as string, 'public')).toBeNull();
    expect(await loadSession(a.db, tokens[2] as string, 'admin')).toBeNull();
    const row = (await a.admin.query('SELECT status, banned_until, ban_reason FROM app_user WHERE id = $1', [u.id]))
      .rows[0];
    expect(row.status).toBe('banned');
    expect(row.ban_reason).toBe(reason);
    expect(Math.abs(row.banned_until.getTime() - until.getTime())).toBeLessThan(1_000);
    // Someone else's session is untouched.
    expect((await loadSession(a.db, keep, 'public'))?.user.id).toBe(bystander.id);

    const audit = (await a.admin.query('SELECT * FROM audit_log WHERE target_id = $1', [u.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'user.ban',
      actor_id: bystander.id,
      actor_kind: 'moderator',
      target_kind: 'app_user',
      detail: { permanent: false },
    });
    expect(JSON.stringify(audit[0])).not.toContain('harassment');
    expect(JSON.stringify(audit[0])).not.toContain('4711');
  });

  it('a permanent ban by the system; an unknown user is false and writes nothing', async () => {
    const u = await a.newUser();
    expect(await banUser(a.db, { userId: u.id, until: null, reason: 'spam', actorId: null, actorKind: 'system' })).toBe(
      true,
    );
    const row = (await a.admin.query('SELECT status, banned_until FROM app_user WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ status: 'banned', banned_until: null });
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await banUser(a.db, { userId: ghost, until: null, reason: 'x', actorId: null, actorKind: 'system' })).toBe(
      false,
    );
    expect((await a.admin.query('SELECT 1 FROM audit_log WHERE target_id = $1', [ghost])).rowCount).toBe(0);
  });
});
