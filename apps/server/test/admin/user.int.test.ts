import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Harness, openHarness } from './harness.ts';

// `admin user role` as mjk_api: the role changes and one audit row (codes and ids only) records it.

let h: Harness;
let userId: string;
beforeAll(async () => {
  h = await openHarness();
  userId = (
    await h.api.query<{ id: string }>(
      `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version, terms_accepted_at)
       VALUES ('ann@example.com', now(), 'ann', 'Ann', now(), 'v1', now()) RETURNING id`,
    )
  ).rows[0]?.id as string;
});
afterAll(async () => {
  await h?.close();
});

const role = async () =>
  (await h.api.query<{ role: string }>('SELECT role FROM app_user WHERE id = $1', [userId])).rows[0]?.role;
const audits = async () => (await h.api.query<{ j: string }>('SELECT row_to_json(a)::text AS j FROM audit_log a')).rows;

it('sets the role and writes one audit row', async () => {
  expect(await role()).toBe('user');
  expect(await h.admin('user', 'role', 'ann', 'moderator')).toEqual({
    code: 0,
    out: ['user ann role moderator'],
    err: [],
  });
  expect(await role()).toBe('moderator');
  const rows = await audits();
  expect(rows).toHaveLength(1);
  expect(JSON.parse((rows[0] as { j: string }).j)).toMatchObject({
    actor_kind: 'admin',
    actor_id: null,
    action: 'user.role',
    target_kind: 'user',
    target_id: userId,
    detail: { role: 'moderator' },
  });
  expect((rows[0] as { j: string }).j).not.toContain('example.com');
});

it('an unknown handle exits 66 and writes nothing', async () => {
  const n = (await audits()).length;
  const r = await h.admin('user', 'role', 'nobody', 'admin');
  expect(r).toEqual({ code: 66, out: [], err: ['admin: user_not_found'] });
  expect((await audits()).length).toBe(n);
});

it.each([[['ann', 'root']], [['ann']], [['Ann', 'admin']], [['a', 'admin']], [['ann', 'admin', 'extra']]])(
  'bad input %j exits 64 and changes nothing',
  async (args) => {
    const n = (await audits()).length;
    expect((await h.admin('user', 'role', ...args)).code).toBe(64);
    expect(await role()).toBe('moderator');
    expect((await audits()).length).toBe(n);
  },
);
