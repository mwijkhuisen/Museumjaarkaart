import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { LETTERMINT_URL, lettermintMailer } from '../../src/mail/lettermint.ts';
import { MailError, memoryMailer } from '../../src/mail/mailer.ts';

// Lettermint's send endpoint is an msw handler: CI never calls it (invariant 9).

const TOKEN = ['lm', 'test', 'token', '0123456789'].join('_');
const ENV = { MJK_MAIL_FROM: 'noreply@example.test', MJK_BRAND_NAME: ['Test', 'Brand'].join('') };
const MSG = { to: 'member@example.test', subject: 'A subject', text: 'The text of the mail.' };

const secrets = (token: string | null = TOKEN) => {
  const dir = mkdtempSync(join(tmpdir(), 'mjk-lm-'));
  if (token !== null) writeFileSync(join(dir, 'lettermint_api_token'), `${token}\n`);
  return dir;
};

let seen: { headers: Headers; body: unknown; redirect: string; hasSignal: boolean }[];
beforeEach(() => {
  seen = [];
});

const answer = (status: number) =>
  server.use(
    http.post(LETTERMINT_URL, async ({ request }) => {
      seen.push({
        headers: request.headers,
        body: await request.json(),
        redirect: request.redirect,
        hasSignal: request.signal !== undefined,
      });
      return status === 202
        ? HttpResponse.json({ message_id: 'm1', status: 'pending' }, { status })
        : HttpResponse.json({ error: 'echo member@example.test' }, { status });
    }),
  );

it('posts the token header, the sender, the recipient, the subject and the text', async () => {
  answer(202);
  const spy = vi.spyOn(globalThis, 'fetch');
  await lettermintMailer(ENV, secrets()).send(MSG);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.headers.get('x-lettermint-token')).toBe(TOKEN);
  expect(seen[0]?.body).toEqual({
    from: `${ENV.MJK_BRAND_NAME} <noreply@example.test>`,
    to: ['member@example.test'],
    subject: 'A subject',
    text: 'The text of the mail.',
    settings: { track_opens: false, track_clicks: false },
  });
  const init = spy.mock.calls[0]?.[1];
  expect(init?.redirect).toBe('error');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  spy.mockRestore();
});

it.each([
  [401, 'mail_refused', false],
  [403, 'mail_refused', false],
  [400, 'mail_invalid', false],
  [422, 'mail_invalid', false],
  [429, 'mail_unavailable', true],
  [500, 'mail_unavailable', true],
  [503, 'mail_unavailable', true],
])('%i is %s (retry %s) and the error quotes nothing', async (status, code, retry) => {
  answer(status);
  const err = await lettermintMailer(ENV, secrets())
    .send(MSG)
    .catch((e) => e);
  expect(err).toBeInstanceOf(MailError);
  expect(err).toMatchObject({ code, retry, message: code });
  expect(JSON.stringify(err)).not.toContain('member@example.test');
});

it('a network error is mail_unavailable', async () => {
  server.use(http.post(LETTERMINT_URL, () => HttpResponse.error()));
  await expect(lettermintMailer(ENV, secrets()).send(MSG)).rejects.toMatchObject({
    code: 'mail_unavailable',
    retry: true,
  });
});

it('a redirect is mail_unavailable, not followed', async () => {
  server.use(
    http.post(
      LETTERMINT_URL,
      () => new HttpResponse(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    ),
  );
  await expect(lettermintMailer(ENV, secrets()).send(MSG)).rejects.toMatchObject({ code: 'mail_unavailable' });
});

describe('mail_unconfigured', () => {
  it.each([
    ['a missing token file', ENV, null],
    ['a malformed token', ENV, 'short'],
    ['no sender', { MJK_BRAND_NAME: ENV.MJK_BRAND_NAME }, TOKEN],
    ['a sender that is no address', { ...ENV, MJK_MAIL_FROM: 'not an address' }, TOKEN],
    ['no brand', { MJK_MAIL_FROM: ENV.MJK_MAIL_FROM }, TOKEN],
    ['a brand that breaks the header', { ...ENV, MJK_BRAND_NAME: 'Evil <x@y.z>' }, TOKEN],
  ])('%s', async (_name, env, token) => {
    // No msw handler: a request would fail the test.
    await expect(lettermintMailer(env, secrets(token)).send(MSG)).rejects.toMatchObject({
      code: 'mail_unconfigured',
      retry: false,
    });
  });
});

it('reads the token on every send', async () => {
  answer(202);
  const dir = secrets(null);
  const mailer = lettermintMailer(ENV, dir);
  await expect(mailer.send(MSG)).rejects.toMatchObject({ code: 'mail_unconfigured' });
  writeFileSync(join(dir, 'lettermint_api_token'), TOKEN);
  await mailer.send(MSG);
  expect(seen).toHaveLength(1);
});

it('the memory mailer keeps what it is sent', async () => {
  const { mailer, sent } = memoryMailer();
  await mailer.send(MSG);
  expect(sent()).toEqual([MSG]);
});
