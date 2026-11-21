import { expect, test } from './fixtures.ts';
import { HOSTILE_SLUG, LOCALES, museumDetail, museumPath, normalMuseum } from './helpers.ts';

// Criterion 4 (invariant 5): user-controlled text never reaches an HTML sink; the hostile page is as quiet as any other.
for (const locale of LOCALES) {
  test(`${locale}: the hostile museum renders as text`, async ({ page, request }) => {
    const hostile = await museumDetail(request, HOSTILE_SLUG);
    expect(hostile.name, 'the fixture is hostile').toContain('</script>');
    const name = locale === 'en' && hostile.name_en !== null ? hostile.name_en : hostile.name;
    const normal = await normalMuseum(request);
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await page.goto(museumPath(locale, normal.slug));
    const normalScripts = await page.locator('script').count();

    await page.goto(museumPath(locale, HOSTILE_SLUG));
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    expect(await page.locator('script').count(), 'as many script elements as a normal museum').toBe(normalScripts);

    const state = JSON.parse((await page.locator('#mjk-state').textContent()) as string);
    expect(state[`/api/v1/museums/${HOSTILE_SLUG}`].name).toBe(hostile.name);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) as string);
    expect(ld.name).toBe(name);

    const description = locale === 'en' ? (hostile.description_en ?? hostile.description_nl) : hostile.description_nl;
    await expect(page.getByRole('main').getByText(description as string, { exact: true })).toBeVisible();
    expect(dialogs, 'no dialog opened').toEqual([]);
  });
}
