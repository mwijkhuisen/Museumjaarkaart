import { request as pwRequest } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { mailbox, t } from './helpers.ts';

// P2a: the admin host (invariant 3). Cloudflare Access adds the JWT in front of the real thing; here the spec sends
// it itself (access-stub.mjs minted one per owner; stack.sh made owner_chromium `admin` and owner_webkit `moderator`
// through the production CLI), and the api checks it against the certs the edge serves. The edge never injects it,
// so a request without it is a 401. One owner per engine: a new code voids the last one, and the engines may run
// this file at the same time.
const OWNERS = {
  chromium: { jwt: process.env.E2E_ACCESS_JWT_CHROMIUM, role: 'role_admin' },
  webkit: { jwt: process.env.E2E_ACCESS_JWT_WEBKIT, role: 'role_moderator' },
} as const;

// The SPA asks GET /api/admin/me first, and a signed-out owner gets its 401 (that is how it shows the sign-in): the
// browser logs that as a console error.
test.use({
  baseURL: 'https://admin.mjk.test',
  allowedConsole: [/status of 401/], // one pattern: a two-element array would read as [value, options]
});

test('the owner signs in by code on the admin host', async ({ page, request, browserName }) => {
  const owner = OWNERS[browserName as keyof typeof OWNERS];
  if (!owner?.jwt) throw new Error('E2E_ACCESS_JWT_CHROMIUM and _WEBKIT are required: run deploy/e2e/stack.sh');
  const email = `owner-${browserName}@mjk.test`;
  const mail = mailbox(request, email);
  await page.setExtraHTTPHeaders({ 'cf-access-jwt-assertion': owner.jwt });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: t('admin_title'), level: 1 })).toBeVisible();
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await send.click();
  await page.getByLabel(t('field_code')).fill(await mail.code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  const signedIn = t('admin_signed_in').replace('{handle}', `owner_${browserName}`).replace('{role}', t(owner.role));
  await expect(page.getByText(signedIn)).toBeVisible();
});

test('without the Access JWT the admin api answers 401', async ({ baseURL }) => {
  const bare = await pwRequest.newContext({ baseURL: baseURL as string, ignoreHTTPSErrors: true });
  expect((await bare.get('/api/admin/me')).status()).toBe(401);
  await bare.dispose();
});
