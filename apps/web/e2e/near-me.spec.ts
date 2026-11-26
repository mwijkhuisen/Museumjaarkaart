import { expect, test } from './fixtures.ts';
import { LOCALES, mapPath, messages, museumPath } from './helpers.ts';

// P1d criterion: near me lists the museums in the API's order, rounds the position to 3 decimals before the request,
// never puts it in a URL, and a denied permission gives a message with the list still there (A§15.3). That the position
// is in no log is checked by deploy/e2e/stack.sh against the api, ssr and caddy logs after this spec has run: the raw
// position below (52.37312, 4.89351) and its rounding (52.373, 4.894) are the needles it greps for.

const NEAR = '/api/v1/museums/near?lat=52.373&lon=4.894';

type Near = { items: { slug: string; name: string; distance_m: number }[] };

test.describe('with the permission granted', () => {
  test.use({ geolocation: { latitude: 52.37312, longitude: 4.89351 }, permissions: ['geolocation'] });

  for (const locale of LOCALES) {
    test(`${locale}: a press sends the rounded position and lists the API's answer in its order`, async ({
      page,
      request,
    }) => {
      const near: string[] = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/v1/museums/near') near.push(req.url());
      });
      await page.goto(mapPath(locale));
      const button = page.locator('#near-me-button');
      await expect(button).toBeVisible();
      // Nothing is asked or sent before the press.
      expect(near).toEqual([]);
      const pageUrl = page.url();

      await button.click();
      await expect(page.locator('#near-me-results')).toBeVisible();

      expect(near, 'one request').toHaveLength(1);
      const url = new URL(near[0] as string);
      expect(`${url.pathname}${url.search}`).toBe(NEAR);
      for (const value of url.searchParams.values()) expect(value).toMatch(/^-?\d+(\.\d{1,3})?$/);
      expect(page.url(), 'the position is in no page URL').toBe(pageUrl);

      const expected = ((await (await request.get(NEAR)).json()) as Near).items;
      expect(expected.length).toBeGreaterThan(0);
      const links = page.locator('#near-me-results li a');
      await expect(links).toHaveCount(expected.length);
      expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(
        expected.map((m) => museumPath(locale, m.slug)),
      );
      await expect(page.locator('#near-me-results .near-me__distance').first()).not.toBeEmpty();
      await expect(page.locator('#near-me-status')).toContainText(String(expected.length));
    });
  }
});

test.describe('with the permission denied', () => {
  test.use({ permissions: [] });

  for (const locale of LOCALES) {
    test(`${locale}: a press shows the denied message and the list is still there`, async ({ page }) => {
      const near: string[] = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/v1/museums/near') near.push(req.url());
      });
      await page.goto(mapPath(locale));
      await page.locator('#near-me-button').click();
      await expect(page.locator('#near-me-status')).toHaveText(messages(locale).near_denied as string);
      await expect(page.locator('#near-me-results')).toHaveCount(0);
      expect(near, 'nothing was sent').toEqual([]);
      const cards = page.locator('ul.card-list > li');
      await expect(cards.first()).toBeVisible();
      expect(await cards.count()).toBeGreaterThan(0);
      await expect(page.locator('ul.card-list a').first()).toHaveAttribute(
        'href',
        new RegExp(`^${museumPath(locale, '').replace(/\/$/, '')}/`),
      );
    });
  }
});
