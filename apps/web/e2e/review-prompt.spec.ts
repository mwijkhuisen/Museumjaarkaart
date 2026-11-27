import { expect, test } from './fixtures.ts';
import { mailbox, museumPath, t } from './helpers.ts';

// P3a WP7 (criteria 5 and 9): the member's review screens end to end, in each engine with its own seeded reviewer
// (seed-e2e.ts: `reviewer_<engine>`, one dated visit to R4, no review). Log a visit, get the prompt, save a rating
// alone, edit it by keyboard, then delete the cited visit in /paspoort through the two choices. The guard of
// fixtures.ts covers the CSP, the hosts and the console on every page.

const SLUG = 'museum-veere-museum-de-schotse-huizen'; // R4: open, no review
const NEW_VISIT = '2026-10-01';

// The cited visit's delete answers 409, which the browser logs as a failed resource.
test.use({ allowedConsole: [/status of 409/] });

test('log a visit, review it with a rating alone, edit by keyboard, delete the cited visit', async ({
  page,
  request,
  browserName,
}) => {
  test.slow(); // an ALTCHA solution, a mailed code and several page loads
  const email = `reviewer-${browserName}@mjk.test`;
  const name = `E2E Reviewer ${browserName}`;
  const handle = `reviewer_${browserName}`;
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

  // 2. The museum page: log a visit; the prompt names the museum and opens the form with that visit chosen.
  await page.goto(museumPath('nl', SLUG));
  const museumName = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
  await page.getByLabel(t('marks_visit_date')).fill(NEW_VISIT);
  await page.getByRole('button', { name: t('marks_visit_submit') }).click();
  const prompt = page.getByRole('button', { name: t('review_mine_prompt').replace('{name}', museumName) });
  await expect(prompt).toBeVisible();
  await prompt.click();
  const form = page.locator('form.review-form');
  await expect(form).toBeVisible();
  await expect(form.getByLabel(t('review_form_visit'))).toHaveValue(/.+/);
  await expect(form.locator('select option:checked')).toHaveText('1 oktober 2026');
  await expect(form.getByText(t('review_form_public_date').replace('{date}', '1 oktober 2026'))).toBeVisible();

  // 3. The rating alone saves (no aspect, no text).
  const group = (legend: string) => form.getByRole('group', { name: legend });
  await group(t('review_form_rating')).getByLabel(t('review_form_stars').replace('{n}', '4')).check();
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/reviews'));
  await form.getByRole('button', { name: t('action_save'), exact: true }).click();
  expect((await created).status()).toBe(201);
  // The form closes after the answer: until then its own "4 van 5" labels would match too (WebKit, a race).
  await expect(form).toHaveCount(0);
  const mine = page.getByRole('region', { name: t('review_mine_h') });
  await expect(mine.getByText(t('review_form_stars').replace('{n}', '4'))).toBeVisible();
  await expect(mine.getByText(t('review_mine_edited'))).toHaveCount(0);
  const list = await request.get(`/api/v1/museums/${SLUG}/reviews`);
  expect(list.ok()).toBe(true);
  expect(
    ((await list.json()) as { items: { author: { handle: string } }[] }).items.map((r) => r.author.handle),
  ).toContain(handle);

  // 4. Edit by keyboard: Tab into the rating group, arrow keys and Space work on the native radios.
  await mine.getByRole('button', { name: t('passport_edit') }).click();
  const rating = group(t('review_form_rating'));
  await rating.getByLabel(t('review_form_stars').replace('{n}', '4')).focus();
  await page.keyboard.press('ArrowRight');
  await expect(rating.getByLabel(t('review_form_stars').replace('{n}', '5'))).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(rating.getByLabel(t('review_form_stars').replace('{n}', '3'))).toBeChecked();
  const kid = group(t('review_form_aspect_kid_friendly'));
  await kid.getByLabel(t('review_form_stars').replace('{n}', '2')).focus();
  await page.keyboard.press('Space');
  await expect(kid.getByLabel(t('review_form_stars').replace('{n}', '2'))).toBeChecked();
  await form.getByLabel(t('review_form_body')).fill('Rustig en mooi.');
  const edited = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/v1\/reviews\//.test(r.url()));
  await form.getByRole('button', { name: t('action_save'), exact: true }).click();
  expect((await edited).status()).toBe(200);
  await expect(form).toHaveCount(0);
  await expect(mine.getByText(t('review_mine_edited'))).toBeVisible();
  await expect(mine.getByText('Rustig en mooi.')).toBeVisible();

  // 5. /paspoort: the visit the review cites cannot go; the two choices; deleting the review lets the visit go.
  await page
    .getByRole('banner')
    .getByRole('link', { name: t('page_passport') })
    .click();
  await expect(page).toHaveURL(/\/paspoort$/);
  const visits = page.getByRole('region', { name: t('passport_h_visits') });
  const row = visits.getByRole('listitem').filter({ hasText: '1 oktober 2026' });
  await row.getByRole('button', { name: t('passport_delete'), exact: true }).click();
  await row.getByRole('button', { name: t('passport_delete_sure') }).click();
  const choices = row.getByRole('group', { name: t('review_cited_h') });
  await expect(choices).toBeVisible();
  await expect(choices.getByRole('button', { name: t('review_cited_move') })).toBeVisible();
  await choices.getByRole('button', { name: t('review_cited_delete') }).click();
  await expect(row).toHaveCount(0);
  const after = await request.get(`/api/v1/museums/${SLUG}/reviews`);
  const authors = ((await after.json()) as { items: { author: { handle: string } }[] }).items.map(
    (r) => r.author.handle,
  );
  expect(authors).not.toContain(handle); // the other engine's reviewer may have a review here at the same time
});
