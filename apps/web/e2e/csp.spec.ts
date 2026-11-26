import { expect, test } from './fixtures.ts';
import { LOCALES, normalMuseum, pageKinds } from './helpers.ts';

// Criterion 3 (A§15.6): a strict CSP on every page kind. The guard fails on any violation and any off-host
// request; here each document carries the header and holds no inline script besides the data blocks.
// The 404 and 400 documents make Chromium log "Failed to load resource" for the document itself: expected.
test.use({ allowedConsole: [/Failed to load resource: the server responded with a status of (400|404)/] });

const STATE = 'script[type="application/json"]#mjk-state';
const LD = 'script[type="application/ld+json"]#';

for (const locale of LOCALES) {
  test(`${locale}: every page kind keeps the CSP`, async ({ page, request }) => {
    const museum = await normalMuseum(request);
    const en = locale === 'en';
    const pages: Record<string, { url: string; status: number }> = {};
    for (const [kind, url] of Object.entries(pageKinds(locale, museum.slug))) pages[kind] = { url, status: 200 };
    pages.notFound = { url: en ? '/en/nope' : '/nope', status: 404 };
    pages.badRequest = { url: `${en ? '/en/museums' : '/musea'}?mk=bogus`, status: 400 };

    for (const [kind, { url, status }] of Object.entries(pages)) {
      const res = await page.goto(url);
      expect(res?.status(), kind).toBe(status);
      expect(res?.headers()['content-security-policy'], kind).toContain("script-src 'self'");
      await page.waitForLoadState('networkidle');
      // The map loads its chunk, tiles and glyphs after hydration, and leaving the page mid-load aborts them (WebKit
      // reports that as a page error): the map settles first, under the same guard.
      if (kind === 'map') await expect(page.locator('#museum-map')).toHaveAttribute('data-map-state', 'ready');
      const inline = await page.$$eval('script:not([src])', (els) =>
        els.map((e) => `script[type="${e.getAttribute('type')}"]#${e.id}`),
      );
      const expected = status !== 200 ? [] : kind === 'museum' ? [LD, STATE] : [STATE];
      expect(inline.sort(), kind).toEqual(expected.sort());
      // Error documents are static: no script at all, so no client.
      if (status !== 200) expect(await page.locator('script').count(), `${kind}: no script`).toBe(0);
    }
  });
}
