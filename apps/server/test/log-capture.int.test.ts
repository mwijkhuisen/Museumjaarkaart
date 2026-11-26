import { TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite } from '../src/auth/invite.ts';
import { memoryLogger } from '../src/lib/log.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { mailJobs } from '../src/worker/mail.ts';
import { purge } from '../src/worker/purge.ts';
import { accountsApp, altchaPayload, codeFor, tokenOf } from './auth/app.ts';
import { type AuthDb, openAuthDb } from './auth/fixtures.ts';

// Criterion 15 and invariant 8 (A§17.7 "Logs"): every account flow, in-process, on the api's and
// the worker's loggers; then no line may hold an email, a code, a password, a session token, the
// invite code or a client address. The container logs of the e2e stack get the same check in
// deploy/e2e/stack.sh.

const PEER = '198.51.100.77';
const PASSWORD = 'Zq7-log-capture-Password';
const NEW_PASSWORD = 'Zq7-log-capture-Changed';

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
const secrets: string[] = [PEER, PASSWORD, NEW_PASSWORD];

beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('the logs of every account flow', () => {
  it('hold fixed codes only: no email, code, password, token, invite or address', async () => {
    const email = `logcap.${process.pid}@example.org`;
    const changed = `logcap.new.${process.pid}@example.org`;
    const invite = await createInvite(a.db, t.keys, { maxUses: 1, days: 1 });
    secrets.push(email, changed, invite.code, 'example.org');
    const r = (path: string, body?: unknown, cookie?: string, method?: string) =>
      t.req(path, {
        peer: PEER,
        ...(body === undefined ? {} : { body }),
        ...(cookie ? { cookie } : {}),
        ...(method ? { method } : {}),
      });

    // Sign-up, its code, and a refused second sign-up on the same invite.
    expect(
      (
        await r('/auth/signup', {
          invite: invite.code,
          email,
          handle: `logcap_${process.pid % 10_000}`,
          display_name: 'Log Capture',
          age_confirmed: true,
          terms_version: TERMS_VERSION,
          altcha: await altchaPayload(t.req),
          locale: 'nl',
        })
      ).status,
    ).toBe(202);
    const signupCode = await codeFor(a, t.keys, email, 'signup');
    secrets.push(signupCode);
    expect((await r('/auth/code/verify', { email, purpose: 'signup', code: '000000' })).status).toBe(401);
    const signedUp = await r('/auth/code/verify', { email, purpose: 'signup', code: signupCode });
    expect(signedUp.status).toBe(200);
    let token = tokenOf(signedUp) as string;
    secrets.push(token);

    // A password, a wrong one, the right one.
    expect((await r('/me/password', { password: PASSWORD }, token, 'PUT')).status).toBe(204);
    expect((await r('/auth/password', { email, password: `${PASSWORD}x` })).status).toBe(401);
    const byPassword = await r('/auth/password', { email, password: PASSWORD });
    expect(byPassword.status).toBe(200);
    token = tokenOf(byPassword) as string;
    secrets.push(token);

    // A sign-in code and its verify.
    expect(
      (await r('/auth/code', { email, purpose: 'signin', altcha: await altchaPayload(t.req), locale: 'en' })).status,
    ).toBe(202);
    const signinCode = await codeFor(a, t.keys, email, 'signin');
    secrets.push(signinCode);
    const byCode = await r('/auth/code/verify', { email, purpose: 'signin', code: signinCode }, token);
    expect(byCode.status).toBe(200);
    token = tokenOf(byCode) as string;
    secrets.push(token);

    // An email change and a display-name change.
    expect((await r('/me/email', { email: changed, locale: 'nl' }, token)).status).toBe(202);
    const changeCode = await codeFor(a, t.keys, changed, 'email_change');
    secrets.push(changeCode);
    expect((await r('/me/email/verify', { code: changeCode }, token)).status).toBe(200);
    expect((await r('/me', { display_name: 'Renamed' }, token, 'PATCH')).status).toBe(200);
    expect((await r('/me/sessions', undefined, token)).status).toBe(200);
    expect((await r('/auth/password', { email: changed, password: NEW_PASSWORD })).status).toBe(401);
    expect((await r('/auth/signout', undefined, token, 'POST')).status).toBe(204);

    // The worker: every queued mail job, then the purge.
    const worker = memoryLogger('worker');
    const mail = memoryMailer();
    const handlers = mailJobs({
      db: a.worker,
      keys: t.keys,
      mailer: mail.mailer,
      logger: worker.logger,
      env: {
        MJK_BRAND_NAME: 'Testmerk',
        MJK_DOMAIN: 'mjk.test',
        MJK_CONTACT_EMAIL: 'contact@mjk.test',
        MJK_MAIL_CAP: '3',
      },
    });
    const jobs = await a.admin.query<{ kind: string; payload: unknown }>(
      "SELECT kind, payload FROM job WHERE kind LIKE 'mail_%' ORDER BY id",
    );
    for (const job of jobs.rows) {
      const run = handlers[job.kind];
      if (run !== undefined) await run(job.payload, { signal: new AbortController().signal });
    }
    expect(mail.sent().length).toBeGreaterThan(0);
    await purge(a.worker, worker.logger);

    const text = JSON.stringify([...t.lines(), ...worker.lines()]);
    expect(t.lines().length).toBeGreaterThan(10);
    for (const s of secrets) expect(text, 'a log line holds a secret value').not.toContain(s);
    // Fixed codes only: every msg is a short snake_case code.
    for (const line of [...t.lines(), ...worker.lines()]) expect(String(line.msg)).toMatch(/^[a-z_]{1,40}$/);
  });
});
