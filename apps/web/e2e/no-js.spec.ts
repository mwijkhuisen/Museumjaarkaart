import { expect, test } from './fixtures.ts';
import { LOCALES, messages, mkWord, museumPath, normalMuseum } from './helpers.ts';

// Criterion 1: every page is complete HTML without JavaScript (A§15.1).
test.use({ javaScriptEnabled: false });

for (const locale of LOCALES) {
  const msg = messages(locale);

  test(`${locale}: a museum page holds its name, address and Museumkaart status`, async ({ page, request }) => {
    const museum = await normalMuseum(request);
    await page.goto(museumPath(locale, museum.slug));
    const name = locale === 'en' && museum.name_en !== null ? museum.name_en : museum.name;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByRole('term').filter({ hasText: msg.fact_address as string })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(museum.street as string);
    await expect(page.getByRole('main')).toContainText(mkWord(msg, museum.museumkaart_status));
  });

  test(`${locale}: the search form submits and shows results`, async ({ page }) => {
    await page.goto(locale === 'en' ? '/en/search' : '/zoeken');
    await page.getByLabel(msg.field_q as string).fill('museum');
    await page.getByRole('button', { name: msg.action_search as string }).click();
    await expect(page).toHaveURL(/q=museum/);
    await expect(page.locator('ul.card-list li').first()).toBeVisible();
  });
}
