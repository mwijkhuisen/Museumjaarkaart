import { TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite } from '../src/auth/invite.ts';
import { memoryLogger } from '../src/lib/log.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { mailJobs } from '../src/worker/mail.ts';
import { purge } from '../src/worker/purge.ts';
import { accountsApp, altchaPayload, codeFor, tokenOf } from './auth/app.ts';
import { type AuthDb, openAuthDb } from './auth/fixtures.ts';
import { softCredential } from './auth/soft-authenticator.ts';

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

    // P2b: passkey sign-ins, good, replayed, with a counter that went back, a bad signature, an unknown credential.
    const member = (
      await a.admin.query<{ id: string; h: Buffer }>(
        'SELECT id, webauthn_user_id AS h FROM app_user WHERE email = $1',
        [changed],
      )
    ).rows[0] as { id: string; h: Buffer };
    const cred = softCredential({ userHandle: member.h, counter: 3 });
    await a.admin.query(
      'INSERT INTO passkey (credential_id, user_id, public_key, sign_count, backed_up) VALUES ($1, $2, $3, 3, false)',
      [cred.id, member.id, cred.publicKeyCose],
    );
    secrets.push(
      cred.id.toString('base64url'),
      cred.id.toString('hex'),
      cred.publicKeyCose.toString('base64url'),
      cred.publicKeyCose.toString('hex'),
      member.h.toString('base64url'),
      member.h.toString('hex'),
    );
    const challenge = async () => {
      const c = (
        (await (await r('/auth/passkey/options', undefined, undefined, 'POST')).json()) as { challenge: string }
      ).challenge;
      secrets.push(c);
      return c;
    };
    const good = cred.assert({ challenge: await challenge() });
    secrets.push(good.response.signature, good.response.clientDataJSON, good.response.authenticatorData);
    const byPasskey = await r('/auth/passkey/verify', { credential: good });
    expect(byPasskey.status).toBe(200);
    secrets.push(tokenOf(byPasskey) as string);
    // Re-authentication with the same passkey (owner, 2026-11-27): the session is replaced, and nothing is logged but codes.
    const passkeyToken = tokenOf(byPasskey) as string;
    const reauthOptions = (await (await r('/auth/passkey/reauth/options', undefined, passkeyToken, 'POST')).json()) as {
      challenge: string;
    };
    secrets.push(reauthOptions.challenge);
    const reauth = await r(
      '/auth/passkey/reauth/verify',
      { credential: cred.assert({ challenge: reauthOptions.challenge }) },
      passkeyToken,
    );
    expect(reauth.status).toBe(200);
    secrets.push(tokenOf(reauth) as string);
    expect((await r('/auth/passkey/verify', { credential: good })).status).toBe(401);
    expect(
      (await r('/auth/passkey/verify', { credential: cred.assert({ challenge: await challenge(), counter: 1 }) }))
        .status,
    ).toBe(401);
    expect(
      (
        await r('/auth/passkey/verify', {
          credential: cred.assert({ challenge: await challenge(), badSignature: true }),
        })
      ).status,
    ).toBe(401);
    const stranger = softCredential({ userHandle: Buffer.alloc(16, 1) });
    secrets.push(stranger.id.toString('base64url'));
    expect(
      (await r('/auth/passkey/verify', { credential: stranger.assert({ challenge: await challenge() }) })).status,
    ).toBe(401);
    expect(t.lines().some((l) => l.msg === 'passkey_counter')).toBe(true);

    // P2b: a second passkey over /me/passkeys: options, a forged add, the add, the rename and the removal.
    const added = softCredential({ userHandle: member.h });
    const passkeyName = `Logcap key ${process.pid}`;
    const renamed = `Logcap renamed ${process.pid}`;
    secrets.push(
      added.id.toString('base64url'),
      added.id.toString('hex'),
      added.publicKeyCose.toString('base64url'),
      added.publicKeyCose.toString('hex'),
      passkeyName,
      renamed,
    );
    const regChallenge = async () => {
      const res = await r('/me/passkeys/options', undefined, token, 'POST');
      expect(res.status).toBe(200);
      const c = ((await res.json()) as { challenge: string }).challenge;
      secrets.push(c);
      return c;
    };
    const forged = added.register({ challenge: await regChallenge(), origin: 'https://evil.test' });
    secrets.push(forged.response.clientDataJSON, forged.response.attestationObject);
    expect((await r('/me/passkeys', { credential: forged, name: passkeyName }, token)).status).toBe(422);
    const attestation = added.register({ challenge: await regChallenge() });
    secrets.push(attestation.response.clientDataJSON, attestation.response.attestationObject);
    const registered = await r('/me/passkeys', { credential: attestation, name: passkeyName }, token);
    expect(registered.status).toBe(201);
    const { ref } = (await registered.json()) as { ref: string };
    secrets.push(ref);
    expect((await r('/me/passkeys', { credential: attestation, name: passkeyName }, token)).status).toBe(422);
    expect((await r(`/me/passkeys/${ref}`, { name: renamed }, token, 'PATCH')).status).toBe(200);
    expect((await r('/me/passkeys', undefined, token)).status).toBe(200);
    expect((await r(`/me/passkeys/${ref}`, undefined, token, 'DELETE')).status).toBe(204);
    expect((await r(`/me/passkeys/${ref}`, undefined, token, 'DELETE')).status).toBe(404);

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
