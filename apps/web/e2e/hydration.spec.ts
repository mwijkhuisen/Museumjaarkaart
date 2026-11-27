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

// The error boundary replaces the page after a failed in-place navigation; the title follows it.
test.describe('a failed in-place navigation', () => {
  // One pattern: test.use reads a two-element array as [value, options].
  test.use({ allowedConsole: [/Failed to load resource: the server responded with a status of 404|api_404/] });
  for (const locale of LOCALES) {
    test(`${locale}: the error page sets the document title`, async ({ page }) => {
      const missing = museumPath(locale, 'nergens-te-vinden-museum');
      await page.goto(missing);
      const notFoundTitle = await page.title();
      const notFoundHeading = (await page.getByRole('heading', { level: 1 }).textContent()) as string;
      await page.goto(locale === 'en' ? '/en/' : '/');
      await page.waitForFunction(() =>
        Object.keys(document.getElementById('app') ?? {}).some((k) => k.startsWith('__reactContainer')),
      );
      const homeTitle = await page.title();
      expect(homeTitle).not.toBe(notFoundTitle);
      await page.evaluate((to) => history.pushState(null, '', to), missing);
      // hydrateRoot marks #app at once, but the router adds its popstate listener in an effect of the
      // hydration's commit, later: a popstate in between is lost (WebKit on CI, 2026-11-27). So dispatch
      // until the page follows; once the router listens, a repeat for the same path changes nothing.
      const heading = page.getByRole('heading', { level: 1 });
      await expect(async () => {
        await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate')));
        await expect(heading).toHaveText(notFoundHeading, { timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await expect(page).toHaveTitle(notFoundTitle);
    });
  }
});
