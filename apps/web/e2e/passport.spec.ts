import { expect, test } from './fixtures.ts';
import { mailbox, t } from './helpers.ts';

// P2c: the museum passport end to end, in each engine with its own seeded member (seed-e2e.ts: `passport_<engine>`,
// two dated visits logged three days ago). Sign in through the mail sink, tick three museums on /welkom, see them on
// /paspoort with the Museumkaart list's date, make the visit log public in /account, then look at /u/<handle> without
// a session. The three new visits are under 24 hours old, so the public profile shows the two seeded months and not
// them (A§10, criterion 7). The guard of fixtures.ts covers the CSP, the hosts and the console on every page.

/** A message with `{name}` placeholders as a regular expression; `values` gives the pattern for each one. */
const pattern = (key: string, values: Record<string, string>): RegExp =>
  new RegExp(
    `^${t(key)
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '.+')}$`,
  );

test('tick three museums, see the passport, publish the log, see the profile signed out', async ({
  page,
  context,
  request,
  browserName,
}) => {
  test.slow(); // an ALTCHA solution, a mailed code and several page loads
  const email = `passport-${browserName}@mjk.test`;
  const handle = `passport_${browserName}`;
  const name = `E2E Passport ${browserName}`;
  const signedInAs = t('account_signed_in_as').replace('{name}', name).replace('{handle}', handle);

  // 1. Sign in by code.
  await page.goto('/inloggen');
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await send.click();
  await page.getByLabel(t('field_code')).fill(await mailbox(request, email).code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  await expect(page.getByText(signedInAs)).toBeVisible();
  await page.waitForLoadState('networkidle'); // a full load below must not abort a fetch (WebKit logs it)

  // 2. /welkom: tick the first three museums (never the hostile one) and save in one go.
  await page.goto('/welkom');
  await expect(page.getByRole('heading', { level: 1, name: t('welcome_h') })).toBeVisible();
  const boxes = page.locator('input[name="museum"]');
  await expect(boxes.first()).toBeVisible();
  const ticked: string[] = [];
  for (let i = 0; ticked.length < 3; i++) {
    const box = boxes.nth(i);
    const label = await box.evaluate(
      (el) => el.closest('.check')?.querySelector('label span')?.firstChild?.textContent,
    );
    if (!label || label.includes('script')) continue;
    await box.check();
    ticked.push(label);
  }
  await expect(page.getByText(t('welcome_selected').replace('{n}', '3'))).toBeVisible();
  await page.getByRole('button', { name: t('welcome_save'), exact: true }).click();
  await expect(page.getByText(t('welcome_saved').replace('{added}', '3').replace('{skipped}', '0'))).toBeVisible();

  // 3. /paspoort: the five visits, and N of the list with the list's date.
  await page.getByRole('link', { name: t('welcome_to_passport') }).click();
  await expect(page).toHaveURL(/\/paspoort$/);
  const visits = page.getByRole('region', { name: t('passport_h_visits') });
  for (const museum of ticked) await expect(visits.getByRole('link', { name: museum, exact: true })).toBeVisible();
  await expect(page.locator('.progress__headline')).toHaveText(
    pattern('profile_progress_of_list', { visited: '\\d+', n: '[\\d.]+', date: '\\S+ \\d{4}' }),
  );
  await expect(page.getByText(t('profile_progress_all_time').replace('{n}', '5'))).toBeVisible();

  // 4. /account: the visit log public, saved.
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('nav_account') })
    .click();
  await expect(page).toHaveURL(/\/account$/);
  const settings = page.getByRole('region', { name: t('settings_h') });
  await settings
    .getByRole('group', { name: t('settings_visits') })
    .getByLabel(t('settings_public'))
    .check();
  await settings.getByRole('button', { name: t('action_save'), exact: true }).click();
  await expect(settings.getByText(t('settings_saved'))).toBeVisible();
  await page.waitForLoadState('networkidle');

  // 5. Signed out. A client with no cookie gets the server-rendered page: two months, none of the new museums, no day.
  const anonymous = await request.get(`/u/${handle}`);
  expect(anonymous.status()).toBe(200);
  const markup = await anonymous.text();
  for (const month of ['oktober 2026', 'september 2026']) expect(markup).toContain(month);
  expect(markup).not.toMatch(/\b(12|3) (september|oktober)\b/);
  const list = (await (await request.get(`/api/v1/users/${handle}`)).json()) as {
    visits: { items: { museum: { name: string }; visited_month: string | null }[] };
  };
  expect(list.visits.items.map((i) => i.visited_month)).toEqual(['2026-10', '2026-09']);
  for (const museum of ticked) expect(list.visits.items.map((i) => i.museum.name)).not.toContain(museum);

  // The browser too, once the session cookie is gone: the page, its hydration and its client requests.
  await context.clearCookies();
  await page.goto(`/u/${handle}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const log = page.getByRole('region', { name: t('profile_visits_h') });
  await expect(log.getByRole('heading', { level: 3 })).toHaveText(['oktober 2026', 'september 2026']);
  for (const museum of ticked) await expect(page.getByRole('link', { name: museum, exact: true })).toHaveCount(0);
  await expect(
    page.getByText(pattern('profile_progress_of_list', { visited: '\\d+', n: '[\\d.]+', date: '.+' })),
  ).toBeVisible();
});
