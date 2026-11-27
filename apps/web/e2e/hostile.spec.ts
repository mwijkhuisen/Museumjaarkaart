import { expect, test } from './fixtures.ts';
import { HOSTILE_SLUG, LOCALES, messages, museumDetail, museumPath, normalMuseum } from './helpers.ts';

// Criterion 4 (invariant 5): user-controlled text never reaches an HTML sink; the hostile page is as quiet as any other.
for (const locale of LOCALES) {
  test(`${locale}: the hostile museum renders as text`, async ({ page, request }) => {
    const hostile = await museumDetail(request, HOSTILE_SLUG);
    expect(hostile.name, 'the fixture is hostile').toContain('</script>');
    expect(hostile.street, 'the street too').toContain('<img');
    expect(hostile.place, 'the place too').toContain('</p>');
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
    expect(ld.address).toMatchObject({ streetAddress: hostile.street, addressLocality: hostile.place });
    const facts = page.getByRole('main').locator('dl.facts');
    await expect(facts).toContainText(hostile.street as string);
    await expect(facts).toContainText(hostile.place as string);

    const description = locale === 'en' ? (hostile.description_en ?? hostile.description_nl) : hostile.description_nl;
    await expect(page.getByRole('main').getByText(description as string, { exact: true })).toBeVisible();
    expect(dialogs, 'no dialog opened').toEqual([]);
  });
}

// P3a criterion 3 (invariant 5): a review body is user text. The seed's R1 holds one whose body is
// `</script><b>x</b> [x](y)`, a newline, `Tweede regel` and an emoji. It must stay ONE text node in
// <p class="review-body">: the same text the API stores, no element created from it, the line break kept (CSS's
// pre-line, never a <br>), in the server's page and in a page the SPA renders after an in-place navigation.
const R1 = 'museum-catharijneconvent';

for (const locale of LOCALES) {
  test(`${locale}: a hostile review renders as text, server-rendered and through the SPA`, async ({
    page,
    request,
  }) => {
    const msg = messages(locale);
    const list = (await (await request.get(`/api/v1/museums/${R1}/reviews`)).json()) as {
      items: { body: string | null }[];
    };
    const stored = list.items.find((r) => r.body?.includes('</script>'))?.body as string;
    expect(stored, 'the seeded review is hostile').toContain('</script><b>x</b>');
    expect(stored).toContain('\n');
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const noElement = async () => {
      const body = page.locator('.review-body', { hasText: 'Tweede regel' });
      await expect(body).toHaveCount(1);
      expect(await body.textContent(), 'the stored text, character for character').toBe(stored);
      expect(await body.locator('*').count(), 'no element inside the body').toBe(0);
      expect(await page.getByRole('main').locator('b, br').count(), 'no <b> or <br> in the page').toBe(0);
      expect(await page.getByRole('main').locator('a[href="y"]').count(), 'no link from the markdown').toBe(0);
      expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-line');
      await expect(body).toHaveAttribute('dir', 'auto');
    };

    // 1. The server's page: no client script has run when it is read (the entry module is blocked).
    await page.route('**/assets/entry-client-*.js', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );
    await page.goto(`${museumPath(locale, R1)}/reviews`);
    await noElement();
    await page.unroute('**/assets/entry-client-*.js');

    // 2. The SPA: from the museum page, "Lees de reviews" navigates in place (no reload) and the page renders from a
    // fetch of the API's answer in the browser.
    await page.goto(museumPath(locale, R1));
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      (window as unknown as { __spa: number }).__spa = 1;
    });
    await page.getByRole('link', { name: msg.review_read?.replace(' ({count})', '') as string }).click();
    await expect(page).toHaveURL(new RegExp(`${museumPath(locale, R1)}/reviews$`));
    await noElement();
    expect(
      await page.evaluate(() => (window as unknown as { __spa?: number }).__spa),
      'rendered in place, no page load',
    ).toBe(1);
    expect(dialogs, 'no dialog opened').toEqual([]);
  });
}
