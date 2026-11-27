import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { mailbox, t } from './helpers.ts';

// P2b: passkeys (A§9, A§18). Chromium drives a CDP virtual authenticator (add a passkey, sign out, sign in with it,
// remove it, be refused); WebKit has none in Playwright, so both engines also open the sign-in and account screens
// and assert what the browser really renders: the passkey sections where `PublicKeyCredential` exists, and nothing
// where it does not. The guard of fixtures.ts covers the CSP, the hosts and the console on every page here. The
// invite and the mail sink come from stack.sh (E2E_INVITE, E2E_MAIL_URL); the RP ID is mjk.test.

type Member = { email: string; handle: string; name: string; signedInAs: string };

/** A fresh member by invite, as auth.spec.ts does it; ends on the account page, so the sign-in is fresh. */
async function signUp(page: Page, request: Parameters<typeof mailbox>[0], tag: string, browserName: string) {
  const invite = process.env.E2E_INVITE;
  if (!invite) throw new Error('E2E_INVITE is required: run deploy/e2e/stack.sh');
  const stamp = Date.now();
  const email = `e2e-passkey-${tag}-${browserName}-${stamp}@mjk.test`;
  const handle = `p${tag[0]}_${browserName}_${stamp}`; // at most 30 characters
  const name = `E2E ${tag} ${browserName}`;
  const signedInAs = t('account_signed_in_as').replace('{name}', name).replace('{handle}', handle);
  const mail = mailbox(request, email);

  await page.goto(`/inloggen#uitnodiging=${invite}`);
  await expect(page.getByLabel(t('field_invite'))).toHaveValue(invite);
  await page.getByLabel(t('field_email'), { exact: true }).fill(email);
  await page.getByLabel(t('field_handle'), { exact: true }).fill(handle);
  await page.getByLabel(t('field_display_name'), { exact: true }).fill(name);
  await page.getByLabel(t('auth_age')).check();
  await page.getByLabel(t('auth_terms_agree')).check();
  const submit = page.getByRole('button', { name: t('action_signup') });
  await expect(submit).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await submit.click();
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
  const member: Member = { email, handle, name, signedInAs };
  return member;
}

/** Signs out and reaches /inloggen by in-page navigation (a full load would abort fetches, which WebKit logs). */
async function signOutToSignIn(page: Page) {
  await page.getByRole('button', { name: t('action_signout'), exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/mjk\.test\/$/);
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('nav_account') })
    .click();
  await expect(page).toHaveURL(/\/inloggen$/);
}

test.describe('with a virtual authenticator', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'the virtual authenticator is Chromium-only');
  // The deleted passkey is refused with a 401, which Chromium logs as a failed resource load. The allowance covers
  // the whole test, so the test itself asserts that every 401 is that refusal, in step 5 (below).
  test.use({ allowedConsole: [/status of 401/] }); // one pattern: a two-element array would read as [value, options]

  test('add a passkey, sign out, sign in with it, remove it', async ({ page, request, browserName }) => {
    test.slow();
    // Every 401 of the test, with the step it came in: only step 5's verify call may be one.
    let step = 0;
    const refused: { step: number; method: string; path: string }[] = [];
    page.on('response', (res) => {
      if (res.status() === 401)
        refused.push({ step, method: res.request().method(), path: new URL(res.url()).pathname });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const credentials = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

    const member = await signUp(page, request, 'chromium', browserName);
    const signedIn = page.getByText(member.signedInAs);
    const passkeys = page.getByRole('region', { name: t('account_h_passkeys') });

    step = 1;
    // 1. Add one, with a name: the notice, the list item and one resident credential for mjk.test.
    await expect(passkeys.getByText(t('account_passkeys_none'))).toBeVisible();
    await passkeys.getByLabel(t('field_passkey_name_optional')).fill('E2E laptop');
    await passkeys.getByRole('button', { name: t('action_add_passkey') }).click();
    await expect(passkeys.getByText(t('account_passkey_add_done'))).toBeVisible();
    await expect(passkeys.getByRole('listitem').filter({ hasText: 'E2E laptop' })).toBeVisible();
    const added = await credentials();
    expect(added).toHaveLength(1);
    expect(added[0]?.rpId).toBe('mjk.test');
    expect(added[0]?.isResidentCredential).toBe(true);

    step = 2;
    // 2. Out, and to the sign-in page. The page arms the autofill request too: with the virtual authenticator it may
    // sign the member in by itself before the click. Either way the member ends on the account page.
    await signOutToSignIn(page);
    await expect(page.getByRole('heading', { name: t('auth_passkey_heading') })).toBeVisible();
    const button = page.getByRole('button', { name: t('action_signin_passkey') });
    await expect(signedIn.or(button)).toBeVisible();
    // Give the autofill request a moment to finish by itself; if it does not, the button does the sign-in. A click that
    // finds the button gone (the autofill finished meanwhile) counts as the autofill.
    let autofilled = await signedIn.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (!autofilled)
      autofilled = !(await button.click({ timeout: 5_000 }).then(
        () => true,
        () => false,
      ));
    await expect(signedIn).toBeVisible();
    console.log(
      `passkey sign-in: the autofill ${autofilled ? 'signed in by itself before the click' : 'did not finish by itself; the button signed in'}`,
    );

    step = 3;
    // 3. The current session's method is the passkey, and the list item shows a use.
    const current = page.getByRole('listitem').filter({ hasText: t('account_session_current') });
    await expect(current.getByText(t('session_method_passkey'), { exact: true })).toBeVisible();
    await expect(passkeys.getByText(t('account_passkey_never_used'))).toHaveCount(0);

    step = 4;
    // 4. Remove it (the sign-in is fresh). "Remove" only asks: "No" keeps it, and nothing is sent.
    const removeButton = passkeys.getByRole('button', {
      name: t('action_remove_passkey').replace('{name}', 'E2E laptop'),
    });
    const question = passkeys.getByText(t('account_passkey_remove_confirm').replace('{name}', 'E2E laptop'));
    const deletes: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && new URL(req.url()).pathname.startsWith('/api/v1/me/passkeys/'))
        deletes.push(req.url());
    });
    await removeButton.click();
    await expect(question).toBeVisible();
    await expect(passkeys.getByRole('button', { name: t('action_no'), exact: true })).toBeFocused();
    await passkeys.getByRole('button', { name: t('action_no'), exact: true }).click();
    await expect(question).toHaveCount(0);
    await expect(passkeys.getByRole('listitem').filter({ hasText: 'E2E laptop' })).toBeVisible();
    expect(deletes).toEqual([]);
    // "Yes" removes it: the notice, an empty list.
    await removeButton.click();
    await passkeys.getByRole('button', { name: t('action_yes'), exact: true }).click();
    await expect(passkeys.getByText(t('account_passkey_removed'))).toBeVisible();
    expect(deletes).toHaveLength(1);
    await expect(passkeys.getByText(t('account_passkeys_none'))).toBeVisible();

    step = 5;
    // 5. Out again: the authenticator still holds the credential, the server refuses it.
    await signOutToSignIn(page);
    await expect(page.getByRole('heading', { name: t('auth_passkey_heading') })).toBeVisible();
    await page.getByRole('button', { name: t('action_signin_passkey') }).click();
    await expect(page.getByText(t('auth_err_passkey_failed'))).toBeVisible();
    await expect(signedIn).toHaveCount(0);

    // The only 401s were the refusals of the removed passkey, in step 5; one in steps 1 to 4 fails here.
    expect(refused.length).toBeGreaterThan(0);
    expect(refused).toEqual(refused.map(() => ({ step: 5, method: 'POST', path: '/api/v1/auth/passkey/verify' })));
  });
});

test('the passkey screens on the sign-in and the account page', async ({ page, request, browserName }) => {
  test.slow();
  // Where the browser has WebAuthn, the screens show the passkey sections; where it has none, they show nothing.
  // Opening a page first so that `window` is the app's origin.
  await page.goto('/inloggen');
  const supported = await page.evaluate(() => typeof window.PublicKeyCredential === 'function');
  console.log(`${browserName}: PublicKeyCredential ${supported ? 'present' : 'absent'}`);
  const signInHeading = page.getByRole('heading', { name: t('auth_passkey_heading') });
  const accountHeading = page.getByRole('heading', { name: t('account_h_passkeys') });
  // The sign-in by code is the page's anchor (the sign-up form needs an invite); the lazy chunk and the autofill
  // arming settle behind it.
  await expect(page.getByRole('heading', { name: t('auth_code_heading') })).toBeVisible();
  // Hydrated and settled: the ALTCHA proof of work has solved, so the page's effects (the passkey chunk too) have run.
  await expect(
    page.getByRole('region', { name: t('auth_code_heading') }).getByRole('button', { name: t('action_send_code') }),
  ).toBeEnabled({ timeout: 30_000 });
  if (supported) {
    await expect(signInHeading).toBeVisible();
    await expect(page.getByRole('button', { name: t('action_signin_passkey') })).toBeVisible();
  } else {
    await expect(signInHeading).toHaveCount(0);
  }
  // The same decision as the page makes: the section is absent only when WebAuthn is.
  const conditional = await page.evaluate(
    async () => (await window.PublicKeyCredential?.isConditionalMediationAvailable?.()) === true,
  );
  console.log(`${browserName}: conditional mediation ${conditional ? 'available' : 'unavailable'}`);

  // A hash-only change on /inloggen would not reload the page, so leave it first (the page is settled: nothing aborts).
  await page.goto('/');
  await signUp(page, request, 'screens', browserName);
  if (supported) {
    await expect(accountHeading).toBeVisible();
    await expect(page.getByText(t('account_passkeys_none'))).toBeVisible(); // the list loaded: the chunk and the fetch ran
    await expect(page.getByRole('button', { name: t('action_add_passkey') })).toBeVisible();
  } else {
    // Wait for the sessions list, the last section to load, so that an absent heading is a settled one.
    await expect(page.getByRole('heading', { name: t('account_h_sessions') })).toBeVisible();
    await expect(page.getByText(t('loading'))).toHaveCount(0);
    await expect(accountHeading).toHaveCount(0);
  }
});
