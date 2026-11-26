import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { LOCALES, mapPath, openMap } from './helpers.ts';

// P1d criterion (WCAG 2.5.7, A§15.3): the map is never the only way. With a filter, the keyboard alone (Tab, and
// Enter on the pager's link) reaches every museum link of the list across all its pages, and that set holds every
// museum the map shows for the same filter. Flevoland is the smallest province in the seed (60 museums): at 10 per
// page that is 6 pages.

const PROVINCE = 'NL-FL';
const PER_PAGE = 10;
const MAX_TABS = 400;

type Focus = { list: string | null; pager: boolean };

/** What has the focus: the href of a museum link in the list, or the pager's "next" link. */
const focus = (page: Page) =>
  page.evaluate<Focus>(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLAnchorElement)) return { list: null, pager: false };
    return {
      list: el.closest('ul.card-list') === null ? null : el.getAttribute('href'),
      pager: el.closest('nav.pager') !== null && el.getAttribute('rel') === 'next',
    };
  });

/** The sequential focus navigation starts at the top of the document again (focus may have been lost with a removed link). */
const toTop = (page: Page) =>
  page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.collapse(true);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.scrollTo(0, 0);
  });

const listHrefs = (page: Page) =>
  page.locator('ul.card-list a').evaluateAll((as) => as.map((a) => a.getAttribute('href') as string));

for (const locale of LOCALES) {
  test(`${locale}: the keyboard reaches every museum of the map's filter through the list and its pages`, async ({
    page,
    request,
  }) => {
    const query = `province=${PROVINCE}`;
    const total = ((await (await request.get(`/api/v1/museums?${query}&limit=1`)).json()) as { total: number }).total;
    const pointSlugs = (
      (await (await request.get(`/api/v1/museums/points?${query}`)).json()) as { items: { slug: string }[] }
    ).items.map((p) => p.slug);
    expect(total).toBeGreaterThan(PER_PAGE * 2);
    expect(pointSlugs.length).toBeGreaterThan(0);

    await openMap(page, mapPath(locale, `?${query}&limit=${PER_PAGE}`));
    const reached = new Set<string>();
    let pages = 0;
    for (;;) {
      pages++;
      const links = await listHrefs(page);
      expect(links.length).toBeGreaterThan(0);
      await toTop(page);
      const focused = new Set<string>();
      let atPager = false;
      for (let tabs = 0; tabs < MAX_TABS && !atPager; tabs++) {
        await page.keyboard.press('Tab');
        const now = await focus(page);
        if (now.list !== null) focused.add(now.list);
        atPager = now.pager;
        // The last page has no pager: done once every link of the list has had the focus.
        if (!atPager && links.every((l) => focused.has(l)) && (await page.locator('nav.pager').count()) === 0) break;
      }
      for (const href of links) expect(focused, `${href} on page ${pages}`).toContain(href);
      for (const href of links) reached.add(href.split('/').at(-1) as string);
      if (!atPager) break;
      const first = links[0];
      await page.keyboard.press('Enter');
      // The new page's list: the old one goes first (a "loading" page has no list), then the next page's links come.
      await expect
        .poll(async () => {
          const next = (await listHrefs(page))[0];
          return next !== undefined && next !== first;
        })
        .toBe(true);
      expect(pages, 'a runaway pager').toBeLessThan(total);
    }

    expect(pages, 'pages of the list').toBe(Math.ceil(total / PER_PAGE));
    expect(reached.size, 'museums reached by keyboard').toBe(total);
    for (const slug of pointSlugs) expect(reached, `${slug} is on the map`).toContain(slug);
  });
}
