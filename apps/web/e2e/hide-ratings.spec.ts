import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { mailbox, t } from './helpers.ts';

// P3a WP5: the "hide ratings until I've visited" flag, end to end, in each engine with its own seeded fold member
// (seed-e2e.ts: `fold_<engine>`, the setting on). The flag is one localStorage key and `<html data-hide-ratings>`,
// set by the classic script /assets/prefs-<hash>.js before the first paint: the document itself is the same for
// everyone (no cookie, no inline script, no personal HTML). The guard of fixtures.ts covers the CSP.
// WP6 adds the per-page checks (what is folded, what unfolds) on top of this.

const KEY = 'mjk-hide-ratings';
const flag = (page: Page) =>
  page.evaluate(
    (k) => ({ key: localStorage.getItem(k), attr: document.documentElement.hasAttribute('data-hide-ratings') }),
    KEY,
  );

test('the flag follows the setting, the sign-out and /me, and is on before any client script runs', async ({
  page,
  request,
  browserName,
}) => {
  test.slow(); // an ALTCHA solution, a mailed code and several page loads
  const email = `fold-${browserName}@mjk.test`;
  const handle = `fold_${browserName}`;
  const name = `E2E Fold ${browserName}`;
  const signedInAs = t('account_signed_in_as').replace('{name}', name).replace('{handle}', handle);

  // 1. Sign in by code: the account page answers /me with the setting on, which writes the key and the attribute.
  await page.goto('/inloggen');
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await send.click();
  await page.getByLabel(t('field_code')).fill(await mailbox(request, email).code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  await expect(page.getByText(signedInAs)).toBeVisible();
  await expect.poll(() => flag(page)).toEqual({ key: '1', attr: true });

  // 2. A new page load, the entry module blocked (an empty module): <html> has the attribute while no client script
  // of ours has run, so only the prefs file can have set it, and the document the server sent does not carry it.
  await page.route('**/assets/entry-client-*.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  const prefs = page.waitForResponse((r) => /\/assets\/prefs-[\w-]+\.js$/.test(new URL(r.url()).pathname));
  const response = await page.goto('/');
  expect((await prefs).status()).toBe(200);
  expect(await response?.text()).not.toContain('data-hide-ratings');
  expect(await flag(page)).toEqual({ key: '1', attr: true });
  await page.unroute('**/assets/entry-client-*.js');

  // 3. Setting off in /account removes the key and the attribute; on again puts them back.
  await page.goto('/account');
  const box = page.getByLabel(t('settings_hide_ratings'));
  await expect(box).toBeChecked();
  const save = () =>
    page.getByRole('region', { name: t('settings_h') }).getByRole('button', { name: t('action_save'), exact: true });
  const saved = page.locator('[role="status"]', { hasText: t('settings_saved') });
  const patched = () => page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/v1/me'));
  const off = patched();
  await box.setChecked(false);
  await save().click();
  expect((await off).status()).toBe(200);
  await expect(saved).toBeVisible();
  await expect.poll(() => flag(page)).toEqual({ key: null, attr: false });
  const on = patched();
  await box.setChecked(true);
  await save().click();
  expect((await on).status()).toBe(200);
  await expect.poll(() => flag(page)).toEqual({ key: '1', attr: true });

  // 4. The key removed by hand (a storage wipe): a page that asks /me (the passport) brings it back.
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.goto('/paspoort');
  await expect.poll(() => flag(page)).toEqual({ key: '1', attr: true });

  // 5. Sign out (from the account page, in-page navigation): the flag goes with the session.
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('page_account') })
    .click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole('button', { name: t('action_signout'), exact: true }).click();
  await expect.poll(() => flag(page)).toEqual({ key: null, attr: false });
  expect(await page.evaluate(() => localStorage.getItem('mjk-member'))).toBeNull();
});
