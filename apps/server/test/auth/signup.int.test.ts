import { TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite } from '../../src/auth/invite.ts';
import { accountsApp, altchaPayload, codeFor } from './app.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';

// Criteria 3 (the anonymous mail budget), 7 (invites, ALTCHA, the honeypot, 10 parallel sign-ups on
// one invite), 8 (16+ and the terms version) and 10's sign-up half (the same answer either way).

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
let n = 0;
const next = () => {
  n += 1;
  return {
    email: `new${n}.${process.pid}@example.org`,
    handle: `new_${n}_${process.pid % 1000}`,
    peer: `198.51.${n % 250}.7`,
  };
};

beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

const invite = async (maxUses = 1, days = 14) => (await createInvite(a.db, t.keys, { maxUses, days })).code;

async function signup(over: Record<string, unknown> = {}, who = next()) {
  const body = {
    invite: await invite(),
    email: who.email,
    handle: who.handle,
    display_name: 'Nieuw lid',
    age_confirmed: true,
    terms_version: TERMS_VERSION,
    altcha: await altchaPayload(t.req),
    locale: 'nl',
    ...over,
  };
  return { res: await t.req('/auth/signup', { peer: who.peer, body }), who, body };
}

const verifySignup = (email: string, code: string, peer = '100.70.0.1') =>
  t.req('/auth/code/verify', { peer, body: { email, purpose: 'signup', code } });

const accounts = async (email: string) =>
  (await a.admin.query('SELECT count(*)::int AS n FROM app_user WHERE email = $1', [email])).rows[0]?.n;

describe('sign-up', () => {
  it('mails a code and creates the account only once the code is entered, with the age and terms fields', async () => {
    const { res, who } = await signup();
    expect(res.status).toBe(202);
    expect(await accounts(who.email)).toBe(0);
    const ok = await verifySignup(who.email, await codeFor(a, t.keys, who.email, 'signup'));
    expect(ok.status).toBe(200);
    const row = await a.admin.query(
      'SELECT handle, age_confirmed_at, terms_version, terms_accepted_at, email_verified_at, invite_id FROM app_user WHERE email = $1',
      [who.email],
    );
    expect(row.rows[0]).toMatchObject({ handle: who.handle, terms_version: TERMS_VERSION });
    for (const col of ['age_confirmed_at', 'terms_accepted_at', 'email_verified_at', 'invite_id'])
      expect(row.rows[0]?.[col]).not.toBeNull();
    // Q7: the sign-up's full IP, for 30 days.
    const ip = await a.admin.query("SELECT host(ip) AS ip FROM content_ip_log WHERE target_kind = 'app_user'");
    expect(ip.rows.map((r) => r.ip)).toContain('100.70.0.1');
  });

  it('without the 16+ box or with another terms version → 422, no code, no account', async () => {
    for (const over of [{ age_confirmed: false }, { terms_version: '2020-01-01' }, { handle: 'admin' }]) {
      const before = (await a.admin.query('SELECT count(*)::int AS n FROM email_code')).rows[0]?.n;
      const { res, who } = await signup(over);
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('invalid');
      expect((await a.admin.query('SELECT count(*)::int AS n FROM email_code')).rows[0]?.n).toBe(before);
      expect(await accounts(who.email)).toBe(0);
    }
  });

  it('an unknown, used-up or expired invite → 403', async () => {
    const unknown = await signup({ invite: '0123456789ABCDEF' });
    expect(unknown.res.status).toBe(403);
    const expired = await createInvite(a.db, t.keys, { maxUses: 1, days: 1 });
    await a.admin.query("UPDATE invite SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    expect((await signup({ invite: expired.code })).res.status).toBe(403);
  });

  it('accepts a typed invite: lower case, hyphens, I and O', async () => {
    const code = await invite();
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o');
    expect((await signup({ invite: typed })).res.status).toBe(202);
  });

  it('10 parallel sign-ups on a single-use invite create exactly one account', async () => {
    const code = await invite(1);
    const people = Array.from({ length: 10 }, () => next());
    for (const p of people) expect((await signup({ invite: code }, p)).res.status).toBe(202);
    const codes = await Promise.all(people.map((p) => codeFor(a, t.keys, p.email, 'signup')));
    const results = await Promise.all(people.map((p, i) => verifySignup(p.email, codes[i] as string, p.peer)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(9);
    const made = await a.admin.query('SELECT count(*)::int AS n FROM app_user WHERE email = ANY($1)', [
      people.map((p) => p.email),
    ]);
    expect(made.rows[0]?.n).toBe(1);
  });

  it('a wrong or replayed ALTCHA solution → 400', async () => {
    const wrong = await signup({ altcha: Buffer.from('{"challenge":{},"solution":{}}').toString('base64') });
    expect(wrong.res.status).toBe(400);
    expect(await wrong.res.json()).toEqual({ error: 'bad_request', fields: ['altcha'] });
    const payload = await altchaPayload(t.req);
    expect((await signup({ altcha: payload })).res.status).toBe(202);
    expect((await signup({ altcha: payload })).res.status).toBe(400);
  });

  it('a filled honeypot gets the same answer and creates nothing', async () => {
    const { res, who } = await signup({ website: 'https://spam.example' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(
      (await a.admin.query('SELECT count(*)::int AS n FROM email_code WHERE email = $1', [who.email])).rows[0]?.n,
    ).toBe(0);
  });

  it('answers the same whether or not the email has an account (the worker drops the mail)', async () => {
    const existing = await a.newUser();
    const fresh = await signup();
    const taken = await signup({}, { ...next(), email: existing.email });
    expect(taken.res.status).toBe(fresh.res.status);
    expect(await taken.res.text()).toBe(await fresh.res.text());
    // Both did the same work: a code row and a job each.
    for (const email of [existing.email, fresh.who.email]) {
      const r = await a.admin.query(
        "SELECT count(*)::int AS n FROM email_code WHERE email = $1 AND purpose = 'signup'",
        [email],
      );
      expect(r.rows[0]?.n).toBe(1);
    }
  });

  it('a handle that exists → 409', async () => {
    const u = await a.newUser();
    expect((await signup({ handle: u.handle })).res.status).toBe(409);
  });
});

describe('the anonymous mail budget (A§17.7)', () => {
  it('the 21st sign-up in a day → 429 with Retry-After, while a sign-in code still goes out', async () => {
    await a.admin.query("DELETE FROM rate_limit WHERE bucket = 'signup_site_day'");
    const shared = await invite(100);
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) answers.push((await signup({ invite: shared })).res.status);
    expect(answers.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(answers[20]).toBe(429);
    const member = await a.newUser();
    const r = await t.req('/auth/code', {
      peer: '100.80.0.1',
      body: { email: member.email, purpose: 'signin', altcha: await altchaPayload(t.req), locale: 'nl' },
    });
    expect(r.status).toBe(202);
    expect(await codeFor(a, t.keys, member.email)).toMatch(/^[0-9]{6}$/);
  });
});
