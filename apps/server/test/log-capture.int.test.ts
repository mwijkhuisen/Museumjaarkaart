import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mount } from '../src/api/app.ts';
import { mountMeExports } from '../src/api/routes/me-exports.ts';
import { mountMeImports } from '../src/api/routes/me-imports.ts';
import { mountMeMuseums } from '../src/api/routes/me-museums.ts';
import { mountMeProgress } from '../src/api/routes/me-progress.ts';
import { mountMeVisits } from '../src/api/routes/me-visits.ts';
import { mountMeWishlist } from '../src/api/routes/me-wishlist.ts';
import { mountUsers } from '../src/api/routes/users.ts';
import { createInvite } from '../src/auth/invite.ts';
import { memoryLogger } from '../src/lib/log.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { dataExportJob } from '../src/passport/export/job.ts';
import { mailJobs } from '../src/worker/mail.ts';
import { purge } from '../src/worker/purge.ts';
import type { JobHandler } from '../src/worker/types.ts';
import { meApp } from './api/me-app.ts';
import { accountsApp, altchaPayload, codeFor, tokenOf } from './auth/app.ts';
import { softCredential } from './auth/soft-authenticator.ts';
import { jpeg, openUploads, sha256Hex, writeGuard } from './media/fixtures.ts';
import { openPassportDb, type PassportDb } from './passport/fixtures.ts';
import { mountReviewRoutes, openMuseum } from './reviews/app.ts';

// Criterion 15 and invariant 8 (A§17.7 "Logs"): every account flow, in-process, on the api's and
// the worker's loggers; then no line may hold an email, a code, a password, a session token, the
// invite code or a client address. The container logs of the e2e stack get the same check in
// deploy/e2e/stack.sh.

const PEER = '198.51.100.77';
const PASSWORD = 'Zq7-log-capture-Password';
const NEW_PASSWORD = 'Zq7-log-capture-Changed';

let a: PassportDb;
let t: ReturnType<typeof accountsApp>;
const secrets: string[] = [PEER, PASSWORD, NEW_PASSWORD];

beforeAll(async () => {
  a = await openPassportDb();
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

// P2c (invariant 8, A§14 "Request logs"): the passport routes, the public profile routes and the export job
// log fixed codes only. Every route is driven once with marker strings in the note, the import file, the
// handle and the museum names; no marker, museum name, export id or file name may reach a line.

describe('the logs of the passport routes', () => {
  it('hold no note, import content, museum name, handle, export id or file name', async () => {
    const NOTE = 'NOTE-LOGMARK-81b2';
    const NOTE_2 = 'NOTE-LOGMARK-edit-5d7c';
    const IMPORTED = 'IMPORT-LOGMARK-Zzyzx-Museum';
    const HANDLE = 'logmark_member';
    const exportsDir = mkdtempSync(join(tmpdir(), 'mjk-logcap-exports-'));
    const mount: Mount = (v1, d) => {
      mountMeVisits(v1, d);
      mountMeWishlist(v1, d);
      mountMeMuseums(v1, d);
      mountMeProgress(v1, d);
      mountMeImports(v1, d);
      mountMeExports(v1, { ...d, exportsDir });
      mountUsers(v1, d);
    };
    const app = meApp(a, mount);
    app.state.peer = '198.51.100.88';
    const u = await a.newMember({
      handle: HANDLE,
      settings: { visits_visibility: 'public', wishlist_visibility: 'public' },
    });
    const token = await app.signIn(u.id);
    const museums = [await a.visible(40), await a.visible(41), await a.visible(42)];
    const named = (
      await a.owner.query<{ name: string }>('SELECT name FROM museum WHERE id = ANY($1::uuid[])', [
        museums.map((m) => m.id),
      ])
    ).rows.map((r) => r.name);
    const [m0, m1, m2] = museums as [(typeof museums)[0], (typeof museums)[0], (typeof museums)[0]];
    const ok = async (status: number, path: string, o: Parameters<typeof app.call>[1] = {}) => {
      const r = await app.call(path, { token, ...o });
      expect(r.status, `${o.method ?? 'GET'} ${path}`).toBe(status);
      return r;
    };

    // The member's visit log, wishlist and the museum views.
    const created = (await (
      await ok(201, '/me/visits', { body: { museum_id: m0.id, visited_on: '2026-02-01', note: NOTE } })
    ).json()) as { id: string };
    await ok(200, `/me/visits/${created.id}`, { method: 'PATCH', body: { note: NOTE_2 } });
    await ok(409, '/me/visits', { body: { museum_id: m0.id, visited_on: '2026-02-01', note: NOTE } });
    await ok(200, '/me/visits/bulk', { body: { museum_ids: [m1.id] } });
    await ok(200, '/me/visits?limit=1');
    await ok(204, `/me/wishlist/${m2.id}`, { method: 'PUT' });
    await ok(200, '/me/wishlist');
    await ok(200, '/me/marks');
    await ok(200, '/me/museums?visited=yes');
    await ok(200, `/me/museums/${m0.slug}`);
    await ok(200, '/me/progress');
    await ok(204, `/me/wishlist/${m2.id}`, { method: 'DELETE' });
    await ok(204, `/me/visits/${created.id}`, { method: 'DELETE' });
    await ok(404, `/me/visits/${created.id}`, { method: 'DELETE' });

    // An import: a good file, a refused one, the confirm and a second confirm.
    const preview = (await (
      await ok(201, '/me/imports', {
        body: { format: 'csv', content: `museum,note\n${IMPORTED},${NOTE}\n${named[0]},${NOTE_2}\n` },
      })
    ).json()) as { id: string };
    await ok(422, '/me/imports', { body: { format: 'csv', content: `museum\n"${IMPORTED}\n` } });
    await ok(200, `/me/imports/${preview.id}/confirm`, { body: { choose: [], skip: [1] } });
    await ok(409, `/me/imports/${preview.id}/confirm`, { body: { choose: [], skip: [] } });

    // An export: asked, built by the worker's job, mailed, listed, downloaded, then purged.
    const asked = (await (await ok(202, '/me/exports', { method: 'POST' })).json()) as { id: string };
    await ok(409, '/me/exports', { method: 'POST' });
    const worker = memoryLogger('worker');
    const mail = memoryMailer();
    const jobs: Record<string, JobHandler> = {
      data_export: dataExportJob({ db: a.worker, exportsDir }),
      ...mailJobs({
        db: a.worker,
        keys: app.keys,
        mailer: mail.mailer,
        logger: worker.logger,
        env: {
          MJK_BRAND_NAME: 'Testmerk',
          MJK_DOMAIN: 'mjk.test',
          MJK_CONTACT_EMAIL: 'contact@mjk.test',
          MJK_MAIL_CAP: '300',
        },
      }),
    };
    for (const kind of ['data_export', 'mail_export']) {
      const queued = await a.admin.query<{ kind: string; payload: unknown }>(
        'SELECT kind, payload FROM job WHERE kind = $1 ORDER BY id',
        [kind],
      );
      for (const job of queued.rows) await jobs[job.kind]?.(job.payload, { signal: new AbortController().signal });
    }
    expect(mail.sent().length).toBeGreaterThan(0);
    await ok(200, '/me/exports');
    for (const file of ['export.json', 'visits.csv', 'wishlist.csv']) await ok(200, `/me/exports/${asked.id}/${file}`);
    await ok(404, `/me/exports/${asked.id}/secret.txt`);
    await ok(404, '/me/exports/00000000-0000-4000-8000-000000000001/export.json');
    await a.owner.query(`UPDATE data_export SET expires_at = now() - interval '1 minute' WHERE id = $1`, [asked.id]);
    await ok(404, `/me/exports/${asked.id}/export.json`);
    await purge(a.worker, worker.logger, { exportsDir });

    // The public profile routes, found and not found.
    await ok(200, `/users/${HANDLE}`);
    await ok(200, `/users/${HANDLE}/visits`);
    await ok(200, `/users/${HANDLE}/wishlist`);
    await ok(404, '/users/nobody_here');

    const lines = [...app.lines(), ...worker.lines()];
    expect(app.lines().length).toBeGreaterThan(20);
    const text = JSON.stringify(lines);
    const secrets = [
      NOTE,
      NOTE_2,
      IMPORTED,
      HANDLE,
      asked.id,
      preview.id,
      created.id,
      'export.json',
      'visits.csv',
      'wishlist.csv',
      ...named,
      ...museums.flatMap((m) => [m.id, m.slug]),
    ];
    for (const s of secrets) expect(text, 'a log line holds a secret value').not.toContain(s);
    for (const line of lines) expect(String(line.msg)).toMatch(/^[a-z_]{1,40}$/);
  });
});

// P3a (invariant 8): the review routes log fixed codes only. Every route is driven with marker strings in the
// review text and the handle, through the refusals too (a 422 on the text, a 409, a 404, a 429); no marker, id,
// handle, museum name or address may reach a line.

describe('the logs of the review routes', () => {
  it('hold no review text, handle, id, museum name or address', async () => {
    const BODY = 'REVIEW-LOGMARK-7c3d</script>';
    const BODY_2 = 'REVIEW-LOGMARK-edit-19ab';
    const HANDLE = 'revlog_member';
    const PEER_R = '198.51.100.99';
    const app = meApp(a, mountReviewRoutes);
    app.state.peer = PEER_R;
    const u = await a.newMember({ handle: HANDLE, status: 'active' });
    const token = await app.signIn(u.id);
    const m = await openMuseum(a, 700);
    const m2 = await openMuseum(a, 701);
    const names = (
      await a.owner.query<{ name: string }>('SELECT name FROM museum WHERE id = ANY($1::uuid[])', [[m.id, m2.id]])
    ).rows.map((r) => r.name);
    const visitId = await a.addVisit(u.id, m.id);
    const visit2 = await a.addVisit(u.id, m2.id);
    const ok = async (status: number, path: string, o: Parameters<typeof app.call>[1] = {}) => {
      const r = await app.call(path, { token, ...o });
      expect(r.status, `${o.method ?? 'GET'} ${path}`).toBe(status);
      return r;
    };

    const made = (await (
      await ok(201, '/reviews', { body: { museum_id: m.id, visit_id: visitId, rating: 4, body: BODY } })
    ).json()) as { id: string };
    await ok(409, '/reviews', { body: { museum_id: m.id, visit_id: visitId, rating: 4, body: BODY } });
    await ok(422, '/reviews', { body: { museum_id: m2.id, visit_id: visitId, rating: 4, body: BODY } });
    await ok(422, '/reviews', { body: { museum_id: m2.id, visit_id: visit2, rating: 4, body: `${BODY}\u{202E}` } });
    await ok(400, '/reviews', { body: { museum_id: m2.id, visit_id: visit2, rating: 9, body: BODY } });
    await ok(200, `/reviews/${made.id}`, { method: 'PATCH', body: { body: BODY_2 } });
    await ok(404, `/reviews/${made.id.replace(/.$/, '0')}x`, { method: 'PATCH', body: { body: BODY_2 } });
    await ok(200, `/reviews/${made.id}`);
    await ok(200, `/museums/${m.slug}/reviews`);
    await ok(200, `/users/${HANDLE}/reviews`);
    await ok(404, '/users/nobody_here/reviews');
    await ok(200, `/me/museums/${m.slug}`);
    await ok(409, `/me/visits/${visitId}`, { method: 'DELETE' });
    await ok(204, `/reviews/${made.id}`, { method: 'DELETE' });
    await ok(404, `/reviews/${made.id}`, { method: 'DELETE' });
    await ok(204, `/me/visits/${visitId}`, { method: 'DELETE' });
    // A 429: no client address.
    app.state.peer = undefined;
    await ok(429, '/reviews', { body: { museum_id: m2.id, visit_id: visit2, rating: 4, body: BODY } });

    const lines = app.lines();
    expect(lines.length).toBeGreaterThan(10);
    const text = JSON.stringify(lines);
    const secrets = [
      BODY,
      BODY_2,
      'REVIEW-LOGMARK',
      HANDLE,
      PEER_R,
      made.id,
      visitId,
      visit2,
      u.id,
      ...names,
      m.id,
      m.slug,
      m2.id,
      m2.slug,
    ];
    for (const s of secrets) expect(text, 'a log line holds a secret value').not.toContain(s);
    for (const line of lines) expect(String(line.msg)).toMatch(/^[a-z_]{1,40}$/);
  });
});

describe('the logs of the upload routes', () => {
  it('hold no id, hash, size, museum, handle or address (A§18: the upload flow)', async () => {
    const f = await openUploads(a);
    try {
      const PEER_U = '198.51.100.123';
      const HANDLE = 'uplog_member';
      f.t.state.peer = PEER_U;
      const u = await a.newMember({ handle: HANDLE, status: 'active' });
      const token = await f.t.signIn(u.id);
      const m = await openMuseum(a, 702);
      const bytes = await jpeg(9 * 1024 * 1024);
      const sha = sha256Hex(bytes);
      const { id, done } = await f.upload(token, m.id, bytes);
      expect(done.status).toBe(202);
      await f.t.call(`/uploads/${id}`, { token });
      const bad = await f.upload(token, m.id, Buffer.from('<html>LOGMARK-UPLOAD</html>'));
      expect(bad.done.status).toBe(415);
      const refused = await f.create(token, {
        museumId: m.id,
        size: 1000,
        consents: { own_photo: false, no_people: true, no_artwork: true },
      });
      expect(refused.status).toBe(422);
      await writeGuard(f.guard, 3);
      expect((await f.create(token, { museumId: m.id, size: 1000 })).status).toBe(503);
      const text = JSON.stringify(f.t.lines());
      for (const s of [PEER_U, HANDLE, id, bad.id, sha, u.id, m.id, m.slug, String(bytes.length), 'LOGMARK-UPLOAD'])
        expect(text, 'a log line holds a secret value').not.toContain(s);
      for (const line of f.t.lines()) expect(String(line.msg)).toMatch(/^[a-z_]{1,40}$/);
    } finally {
      await f.close();
    }
  });
});
