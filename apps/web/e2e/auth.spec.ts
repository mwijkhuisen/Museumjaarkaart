import { expect, test } from './fixtures.ts';
import { mailbox, t } from './helpers.ts';

// P2a: sign-up by invite, sign-in by code, a password set on the account page, sign-in by password (A§9), in each
// engine with its own address. The invite and the mail sink come from stack.sh (E2E_INVITE, E2E_MAIL_URL); the codes
// arrive through the worker's real Lettermint client. The ALTCHA widget solves on load: the specs only wait for it.
const PASSWORD = 'e2e staple seven horses'; // stack.sh's log check looks for this string (spaces: no gitleaks match)

test('sign up by invite, sign in by code, set a password, sign in by password', async ({
  page,
  request,
  browserName,
}) => {
  test.slow(); // two ALTCHA solutions, two mailed codes and two password hashes in one flow
  const invite = process.env.E2E_INVITE;
  if (!invite) throw new Error('E2E_INVITE is required: run deploy/e2e/stack.sh');
  const stamp = Date.now();
  const email = `e2e-${browserName}-${stamp}@mjk.test`;
  const handle = `e2e_${browserName}_${stamp}`;
  const name = `E2E ${browserName}`;
  const mail = mailbox(request, email);
  const signedInAs = t('account_signed_in_as').replace('{name}', name).replace('{handle}', handle);

  // 1. Sign-up: the invite arrives in the fragment; the 16+ box and the terms are ticked by hand.
  await page.goto(`/inloggen#uitnodiging=${invite}`);
  await expect(page.getByLabel(t('field_invite'))).toHaveValue(invite);
  await page.getByLabel(t('field_email'), { exact: true }).fill(email);
  await page.getByLabel(t('field_handle'), { exact: true }).fill(handle);
  await page.getByLabel(t('field_display_name'), { exact: true }).fill(name);
  await page.getByLabel(t('auth_age')).check();
  await page.getByLabel(t('auth_terms_agree')).check();
  // 5. The sign-up form links the privacy notice and the terms (the footer has its own links).
  const form = page.locator('form');
  await expect(form.getByRole('link', { name: t('auth_privacy_link') })).toHaveAttribute('href', '/privacy');
  await expect(form.getByRole('link', { name: t('auth_terms_link') })).toHaveAttribute('href', '/voorwaarden');
  const signUp = page.getByRole('button', { name: t('action_signup') });
  await expect(signUp).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await signUp.click();

  // 2-3. The code from the sink, then the welcome page and the account page.
  await page.getByLabel(t('field_code')).fill(await mail.code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  // A new member lands on the onboarding; the header's Account link leads on to the account page. In-page
  // navigation once the museums have loaded: a full load would abort a fetch, which WebKit logs as "Load failed".
  await expect(page).toHaveURL(/\/welkom$/);
  await expect(page.locator('input[name="museum"]').first()).toBeVisible();
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('nav_account') })
    .click();
  await expect(page.getByText(signedInAs)).toBeVisible();

  // 4. Out, in by code (a fresh session), a password, out, in by password.
  const signOut = page.getByRole('button', { name: t('action_signout'), exact: true });
  await signOut.click();
  // Signed out, the app goes home; the header's Account link then leads a signed-out visitor to /inloggen. In-page
  // navigation, not page.goto: a full load would abort the home page's fetch, which WebKit logs as "Load failed".
  await expect(page).toHaveURL(/^https:\/\/mjk\.test\/$/);
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('nav_account') })
    .click();
  await expect(page).toHaveURL(/\/inloggen$/);
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
  await page.getByLabel(t('field_code')).fill(await mail.code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  await expect(page.getByText(signedInAs)).toBeVisible();

  await page.getByLabel(t('field_new_password')).fill(PASSWORD);
  await page.getByRole('button', { name: t('action_set_password') }).click();
  await expect(page.getByText(t('account_password_saved'))).toBeVisible();

  await signOut.click();
  // Signed out, the app goes home; the header's Account link then leads a signed-out visitor to /inloggen. In-page
  // navigation, not page.goto: a full load would abort the home page's fetch, which WebKit logs as "Load failed".
  await expect(page).toHaveURL(/^https:\/\/mjk\.test\/$/);
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('nav_account') })
    .click();
  await expect(page).toHaveURL(/\/inloggen$/);
  const byPassword = page.getByRole('region', { name: t('auth_password_heading') });
  await byPassword.getByLabel(t('field_email')).fill(email);
  await byPassword.getByLabel(t('field_password'), { exact: true }).fill(PASSWORD);
  await byPassword.getByRole('button', { name: t('action_signin') }).click();
  await expect(page.getByText(signedInAs)).toBeVisible();
});
