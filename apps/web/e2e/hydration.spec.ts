import { expect, test } from './fixtures.ts';
import { LOCALES, museumPath, normalMuseum } from './helpers.ts';

// Criterion 2 (A§15.1): the client hydrates the server's markup, seeds its cache from `mjk-state` and
// fetches nothing for it. The guard (fixtures.ts) fails the test on a hydration warning or any console error.
for (const locale of LOCALES) {
  test(`${locale}: a museum page hydrates without an API request and navigates in place`, async ({ page, request }) => {
    const museum = await normalMuseum(request);
    const api: string[] = [];
    const documents: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (req.resourceType() === 'document') documents.push(req.url());
      if (url.pathname.startsWith('/api/v1')) api.push(url.pathname);
    });
    await page.goto(museumPath(locale, museum.slug));
    await page.waitForLoadState('networkidle');
    // hydrateRoot has run once React has attached its container key to #app.
    await page.waitForFunction(() =>
      Object.keys(document.getElementById('app') ?? {}).some((k) => k.startsWith('__reactContainer')),
    );
    expect(api, 'data already in mjk-state is not fetched again').toEqual([]);

    const h1 = page.getByRole('heading', { level: 1 });
    const before = (await h1.textContent()) as string;
    // The museum's province link: another route with its own API data.
    const provincePath = locale === 'en' ? '/en/province/' : '/provincie/';
    await page.locator(`main dl a[href^="${provincePath}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${provincePath}[a-z-]+$`));
    await expect(h1).not.toHaveText(before);
    expect(api, 'the new route fetched its data').toContain('/api/v1/museums');
    expect(documents, 'one document request: the navigation was in place').toHaveLength(1);

    api.length = 0;
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${museumPath(locale, museum.slug)}$`));
    await expect(h1).toHaveText(before);
    await page.waitForLoadState('networkidle');
    expect(api, 'the museum comes from the cache').not.toContain(`/api/v1/museums/${museum.slug}`);
    expect(documents).toHaveLength(1);
  });
}
