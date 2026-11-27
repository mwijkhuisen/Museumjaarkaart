import type { APIRequestContext, Page } from '@playwright/test';
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

// ---- P3a WP6: what is folded, page by page ----------------------------------------------------------------------
// The seeded museums (seed-e2e.ts): R2 is visited by the fold member (it unfolds), R1 (the hostile review) and R3 are
// rated and unvisited (they stay folded). Every page that shows a score or a review sits in a RatingFold.

const R1 = 'museum-catharijneconvent';
const R2 = 'nationaal-luchtvaartmuseum';
const R3 = 'fort-bij-vijfhuizen';
const R2_TEXT = 'Prachtige collectie.';
const R3_TEXT = 'Leuk voor een middag.';

/** The id of the review of `slug` whose body is `text`. */
const reviewIdOf = async (request: APIRequestContext, slug: string, text: string): Promise<string> => {
  const list = (await (await request.get(`/api/v1/museums/${slug}/reviews`)).json()) as {
    items: { id: string; body: string | null }[];
  };
  return list.items.find((r) => r.body === text)?.id as string;
};

const mailsTo = async (request: APIRequestContext, to: string): Promise<{ text: string }[]> =>
  (await (await request.get(`${process.env.E2E_MAIL_URL}/messages`, { params: { to } })).json()) as { text: string }[];

/** The code of the next mail to `to`: waits for one newer than those already in the sink (an earlier test mailed too). */
async function nextCode(request: APIRequestContext, to: string, before: number): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const list = await mailsTo(request, to);
        code = list.length > before ? (/\b(\d{6})\b/.exec(list[0]?.text ?? '')?.[1] ?? '') : '';
        return code;
      },
      { message: 'a new mail with a code', timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  return code;
}

const cardOf = (page: Page, slug: string) =>
  page.locator('.card, .review-card').filter({ has: page.locator(`a[href="/musea/${slug}"]`) });

test('every page folds an unvisited museum (the first paint included), unfolds a visited one, and is the same HTML for all', async ({
  page,
  request,
  browserName,
}) => {
  test.slow();
  const email = `fold-${browserName}@mjk.test`;
  const r3Review = await reviewIdOf(request, R3, R3_TEXT);
  const r2Review = await reviewIdOf(request, R2, R2_TEXT);
  const unvisited = [
    `/musea/${R3}`,
    `/musea/${R3}/reviews`,
    `/reviews/${r3Review}`,
    '/musea?min_rating=1',
    '/u/seed_reviewer_4', // reviewed R3 only
  ];
  const visited = [`/musea/${R2}`, `/musea/${R2}/reviews`, `/reviews/${r2Review}`];

  // Sign in as the fold member (a code by mail).
  const before = (await mailsTo(request, email)).length;
  await page.goto('/inloggen');
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await send.click();
  await page.getByLabel(t('field_code')).fill(await nextCode(request, email, before));
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  await expect.poll(() => flag(page)).toEqual({ key: '1', attr: true });

  // 1. The HTML is the same bytes for the fold member (cookie and all) and for an anonymous visitor.
  for (const path of [...unvisited, ...visited, `/en/museums/${R3}/reviews`]) {
    const mine = await page.request.get(path);
    const anonymous = await request.get(path);
    expect(mine.status(), path).toBe(200);
    expect(await mine.text(), path).toBe(await anonymous.text());
  }

  // 2. The first paint, the entry module blocked: the server's page, the flag from the prefs file alone. Nothing of an
  // unvisited museum is visible; the button is.
  await page.route('**/assets/entry-client-*.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  for (const path of [...unvisited, ...visited]) {
    await page.goto(path);
    await expect(page.locator('html'), path).toHaveAttribute('data-hide-ratings', '');
    const bodies = await page.locator('.fold-body').all();
    expect(bodies.length, path).toBeGreaterThan(0);
    for (const body of bodies) await expect(body, path).toBeHidden();
    await expect(page.locator('.fold-show').first(), path).toBeVisible();
    for (const text of [R2_TEXT, R3_TEXT]) await expect(page.getByText(text), path).toBeHidden();
  }
  await page.unroute('**/assets/entry-client-*.js');

  // 3. With the client: the visited museum unfolds once /me/marks answers, the others stay folded.
  await page.goto(`/musea/${R2}/reviews`);
  await expect(page.getByText(R2_TEXT)).toBeVisible();
  await expect(page.locator('.score-summary .fold-body')).toBeVisible();
  await page.goto(`/reviews/${r2Review}`);
  await expect(page.locator('.review-body').first()).toBeVisible();
  await page.goto(`/musea/${R2}`);
  await expect(page.locator('.score-summary .fold-body')).toBeVisible();

  await page.goto(`/musea/${R3}`);
  await expect(page.locator('.score-summary .fold-show')).toBeVisible();
  await expect(page.locator('.score-summary .fold-body')).toBeHidden();

  // The profile list spans museums: each card has its own fold (seed_reviewer_1 reviewed R1 and R2).
  await page.goto('/u/seed_reviewer_1');
  await expect(cardOf(page, R2).locator('.fold-body')).toBeVisible();
  await expect(cardOf(page, R1).locator('.fold-body')).toBeHidden();
  await expect(cardOf(page, R1).locator('.fold-show')).toBeVisible();

  // A list: the card of R2 is open, the cards of R1 and R3 are folded, each with its own link.
  await page.goto('/musea?min_rating=1');
  await expect(cardOf(page, R2).locator('.fold-body')).toBeVisible();
  for (const slug of [R1, R3]) {
    await expect(cardOf(page, slug).locator('.fold-body')).toBeHidden();
    await expect(cardOf(page, slug).getByRole('link', { name: t('page_reviews') })).toBeVisible();
  }

  // 4. A click unfolds that block and moves focus to it (a card in the list, then the museum page).
  const r3Card = cardOf(page, R3);
  await r3Card.getByRole('button', { name: t('fold_show') }).click();
  await expect(r3Card.locator('.fold-body')).toBeVisible();
  await expect(r3Card.locator('.fold-body')).toBeFocused();
  await expect(cardOf(page, R1).locator('.fold-body')).toBeHidden(); // the other card stays folded
  await page.goto(`/musea/${R3}`);
  await page
    .locator('.score-summary')
    .getByRole('button', { name: t('fold_show') })
    .click();
  await expect(page.locator('.score-summary .fold-body')).toBeVisible();
  await expect(page.locator('.score-summary .fold-body')).toBeFocused();
  await page.goto(`/musea/${R3}/reviews`);
  await page
    .getByRole('button', { name: t('fold_show') })
    .first()
    .click();
  await expect(page.locator('.fold-body').first()).toBeFocused();
});
