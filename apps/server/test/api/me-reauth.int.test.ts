import { Me } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCode } from '../../src/auth/codes.ts';
import { open } from '../../src/auth/crypto.ts';
import type { AppKeys } from '../../src/auth/keys.ts';
import { aad } from '../../src/mail/payloads.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { meApp } from './me-app.ts';

// Criterion 5 (A§9): an email change needs a sign-in or code within 10 minutes, a code to the new address
// proves it, and the change ends every other session and tells the old address. The limiter's 30-failure
// cap per IP prefix holds. Each test uses its own /24, so the buckets never meet.

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
}, 120_000);
afterAll(async () => {
  await a?.close();
});

let n = 0;
const peer = () => `198.51.${++n}.7`;

/** The six digits the worker would mail for the newest code of (email, purpose): opened from its queued job. */
async function codeFor(keys: AppKeys, email: string, purpose = 'email_change'): Promise<string> {
  const row = await a.admin.query<{ id: string }>(
    'SELECT id FROM email_code WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC, id DESC LIMIT 1',
    [email, purpose],
  );
  const id = row.rows[0]?.id as string;
  const job = await a.admin.query<{ payload: { sealed: string } }>(
    "SELECT payload FROM job WHERE kind = 'mail_code' AND payload->>'email_code_id' = $1",
    [id],
  );
  const code = open(keys.code_seal, job.rows[0]?.payload.sealed as string, aad.code(id));
  expect(code).toMatch(/^[0-9]{6}$/);
  return code as string;
}

const sessionCount = async (userId: string) =>
  Number((await a.admin.query('SELECT count(*) AS n FROM session WHERE user_id = $1', [userId])).rows[0]?.n);

describe('POST /me/email', () => {
  it('needs a recent sign-in: past 10 minutes it is 403 reauth_required, fresh it is 202', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const body = { email: `new.${u.handle}@example.org`, locale: 'en' };
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '11 minutes' WHERE user_id = $1", [u.id]);
    const stale = await call('/me/email', { token, body });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth_required' });
    await a.admin.query("UPDATE session SET reauth_at = now() - interval '9 minutes' WHERE user_id = $1", [u.id]);
    const fresh = await call('/me/email', { token, body });
    expect(fresh.status).toBe(202);
    expect(await fresh.json()).toEqual({ accepted: true });
  });

  it('refuses the current address (422 on email) and a signed-out caller (401)', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const same = await call('/me/email', {
      token: await signIn(u.id),
      body: { email: u.email.toUpperCase(), locale: 'nl' },
    });
    expect(same.status).toBe(422);
    expect(await same.json()).toEqual({ error: 'invalid', fields: ['email'] });
    expect((await call('/me/email', { body: { email: 'x@example.org', locale: 'nl' } })).status).toBe(401);
  });

  it('is rate limited per (email, prefix): the fourth request is a 429', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const body = { email: `again.${u.handle}@example.org`, locale: 'nl' };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call('/me/email', { token, body })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('without a client address it is a 429 and queues nothing', async () => {
    const { call, signIn, state } = meApp(a);
    const u = await a.newUser();
    const token = await signIn(u.id);
    state.peer = undefined;
    const to = `nobody.${u.handle}@example.org`;
    expect((await call('/me/email', { token, body: { email: to, locale: 'nl' } })).status).toBe(429);
    expect((await a.admin.query('SELECT 1 FROM email_code WHERE email = $1', [to])).rowCount).toBe(0);
  });
});

describe('POST /me/email/verify', () => {
  it('changes the email, ends every other session, keeps this one and queues the notice to the OLD address', async () => {
    const { call, signIn, keys, state, lines } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const other = await signIn(u.id);
    const otherAdmin = await signIn(u.id, 'admin');
    expect(await sessionCount(u.id)).toBe(3);
    const to = `moved.${u.handle}@example.org`;
    expect((await call('/me/email', { token, body: { email: to, locale: 'en' } })).status).toBe(202);
    const code = await codeFor(keys, to);

    const r = await call('/me/email/verify', { token, body: { code } });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json()).user?.email).toBe(to);
    const row = (await a.admin.query('SELECT email, email_verified_at FROM app_user WHERE id = $1', [u.id])).rows[0];
    expect(row.email).toBe(to);

    expect(await sessionCount(u.id)).toBe(1);
    expect((await call('/me', { token })).status).toBe(200);
    expect(Me.parse(await (await call('/me', { token })).json()).user?.email).toBe(to);
    expect((await call('/me', { token: other })).status).toBe(200);
    expect(await (await call('/me', { token: other })).text()).toBe('{"user":null}');
    expect(await (await call('/me', { token: otherAdmin, host: 'admin.mjk.test' })).text()).toBe('{"user":null}');

    const notice = await a.admin.query<{ payload: { sealed_to: string; locale: string } }>(
      "SELECT payload FROM job WHERE kind = 'mail_notice' AND payload->>'user_id' = $1",
      [u.id],
    );
    expect(notice.rowCount).toBe(1);
    expect(open(keys.code_seal, notice.rows[0]?.payload.sealed_to as string, aad.noticeTo(u.id))).toBe(u.email);
    expect(notice.rows[0]?.payload.locale).toBe('nl');

    // The code is single use.
    expect((await call('/me/email/verify', { token, body: { code } })).status).toBe(401);
    const text = JSON.stringify(lines());
    expect(text).not.toContain(u.email);
    expect(text).not.toContain(to);
    expect(text).not.toContain(code);
    expect(text).not.toContain(token);
  });

  it('a signin code never verifies an email change', async () => {
    const { call, signIn, keys, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    await issueCode(a.db, keys, { email: u.email, purpose: 'signin', locale: 'nl' });
    const signinCode = await codeFor(keys, u.email, 'signin');
    expect((await call('/me/email/verify', { token, body: { code: signinCode } })).status).toBe(401);
    // Nor when the member also has a pending change to the very same address.
    await call('/me/email', { token, body: { email: `x.${u.handle}@example.org`, locale: 'nl' } });
    expect((await call('/me/email/verify', { token, body: { code: signinCode } })).status).toBe(401);
    expect((await a.admin.query('SELECT email FROM app_user WHERE id = $1', [u.id])).rows[0].email).toBe(u.email);
  });

  it("another member's pending code never verifies for this member", async () => {
    const { call, signIn, keys, state } = meApp(a);
    state.peer = peer();
    const alice = await a.newUser();
    const bob = await a.newUser();
    const aliceToken = await signIn(alice.id);
    const bobToken = await signIn(bob.id);
    // Bob asks for a change; Alice has asked for nothing.
    const bobNew = `bob.new.${bob.handle}@example.org`;
    await call('/me/email', { token: bobToken, body: { email: bobNew, locale: 'nl' } });
    const bobCode = await codeFor(keys, bobNew);
    expect((await call('/me/email/verify', { token: aliceToken, body: { code: bobCode } })).status).toBe(401);
    // Both ask for the same address: the second code replaces the first, and only its owner passes.
    const shared = `shared.${alice.handle}@example.org`;
    await call('/me/email', { token: aliceToken, body: { email: shared, locale: 'nl' } });
    await call('/me/email', { token: bobToken, body: { email: shared, locale: 'nl' } });
    const sharedCode = await codeFor(keys, shared);
    expect((await call('/me/email/verify', { token: aliceToken, body: { code: sharedCode } })).status).toBe(401);
    expect((await a.admin.query('SELECT email FROM app_user WHERE id = $1', [alice.id])).rows[0].email).toBe(
      alice.email,
    );
    expect((await call('/me/email/verify', { token: bobToken, body: { code: sharedCode } })).status).toBe(200);
  });

  it('the 31st failed verify from one prefix within the hour is a 429', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const statuses = new Set<number>();
    for (let i = 0; i < 30; i++)
      statuses.add((await call('/me/email/verify', { token, body: { code: '000000' } })).status);
    expect([...statuses]).toEqual([401]);
    const r = await call('/me/email/verify', { token, body: { code: '000000' } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a success gives the failure rows back', async () => {
    const { call, signIn, keys, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const to = `refund.${u.handle}@example.org`;
    await call('/me/email', { token, body: { email: to, locale: 'nl' } });
    const code = await codeFor(keys, to);
    const count = async () =>
      Number(
        (
          await a.admin.query(
            "SELECT coalesce(sum(count), 0) AS n FROM rate_limit WHERE bucket = 'verify_fail_prefix' AND key = $1",
            [state.peer?.replace(/\d+$/, '0/24')],
          )
        ).rows[0]?.n,
      );
    expect((await call('/me/email/verify', { token, body: { code: '000000' } })).status).toBe(401);
    expect(await count()).toBe(1);
    expect((await call('/me/email/verify', { token, body: { code } })).status).toBe(200);
    expect(await count()).toBe(1);
  });

  it('a new address taken in the meantime is a 409 and changes nothing', async () => {
    const { call, signIn, keys, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    const other = await signIn(u.id);
    const to = `taken.${u.handle}@example.org`;
    await call('/me/email', { token, body: { email: to, locale: 'nl' } });
    const code = await codeFor(keys, to);
    await a.newUser({ email: to });
    const r = await call('/me/email/verify', { token, body: { code } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'conflict' });
    expect((await a.admin.query('SELECT email FROM app_user WHERE id = $1', [u.id])).rows[0].email).toBe(u.email);
    expect((await call('/me', { token: other })).status).toBe(200);
    expect(await sessionCount(u.id)).toBe(2);
  });

  it('above the site-wide failure threshold it asks for an ALTCHA (400 on altcha)', async () => {
    const { call, signIn, state } = meApp(a);
    state.peer = peer();
    const u = await a.newUser();
    const token = await signIn(u.id);
    await a.admin.query(
      `INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
       VALUES ('verify_fail_site', 'site',
         to_timestamp(floor(extract(epoch from now()) / 3600) * 3600),
         to_timestamp(floor(extract(epoch from now()) / 3600) * 3600) + interval '1 hour', 500)
       ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = 500`,
    );
    const r = await call('/me/email/verify', { token, body: { code: '000000' } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_request', fields: ['altcha'] });
    await a.admin.query("DELETE FROM rate_limit WHERE bucket = 'verify_fail_site'");
  });
});
