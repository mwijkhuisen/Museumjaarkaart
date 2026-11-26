import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { LOCALES, mapPath, museumPath, openMap } from './helpers.ts';

// P1d criterion: the national view shows clusters, a tap on a cluster zooms in, a tap on a museum opens the card
// with a link to its page (A§15.3). The map is read through the element property `mjkMap` of #museum-map.

type Point = { slug: string; name: string; name_en: string | null; lat: number; lon: number };

const points = async (request: import('@playwright/test').APIRequestContext) =>
  ((await (await request.get('/api/v1/museums/points')).json()) as { items: Point[] }).items;

/** The rendered clusters and single museums, de-duplicated (a feature may come back once per tile), with screen positions. */
const rendered = (page: Page) =>
  page.evaluate(() => {
    const map = (document.getElementById('museum-map') as { mjkMap?: import('maplibre-gl').Map }).mjkMap;
    if (map === undefined) throw new Error('no map');
    const out = new Map<string, { cluster: boolean; id: string | number; count: number; x: number; y: number }>();
    for (const f of map.queryRenderedFeatures({ layers: ['museum-clusters', 'museum-points'] })) {
      if (f.geometry.type !== 'Point') continue;
      const props = f.properties as { cluster_id?: number; point_count?: number; slug?: string };
      const cluster = typeof props.cluster_id === 'number';
      const id = cluster ? (props.cluster_id as number) : (props.slug as string);
      const [lon = 0, lat = 0] = f.geometry.coordinates;
      const at = map.project([lon, lat]);
      out.set(`${cluster}:${id}`, { cluster, id, count: props.point_count ?? 1, x: at.x, y: at.y });
    }
    return [...out.values()];
  });

const zoomOf = (page: Page) =>
  page.evaluate(() =>
    (document.getElementById('museum-map') as unknown as { mjkMap: import('maplibre-gl').Map }).mjkMap.getZoom(),
  );

test('the national view shows clusters, far fewer than the museums, and a tap on one zooms in', async ({
  page,
  request,
}) => {
  const all = await points(request);
  expect(all.length, 'the seeded points').toBeGreaterThan(1000);
  await openMap(page, mapPath('nl'));
  // The clustered layer is drawn once the source has loaded its tiles.
  await expect.poll(async () => (await rendered(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  // The whole country is in view (the NL_BOX of @mjk/contracts): maxBounds must leave room for a wide canvas.
  const view = await page.evaluate(() => {
    const b = (
      document.getElementById('museum-map') as unknown as { mjkMap: import('maplibre-gl').Map }
    ).mjkMap.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  });
  expect(view.west, 'the national view reaches Zeeland').toBeLessThanOrEqual(3.2);
  expect(view.east, 'the national view reaches Twente').toBeGreaterThanOrEqual(7.3);
  expect(view.south, 'the national view reaches Limburg').toBeLessThanOrEqual(50.7);
  expect(view.north, 'the national view reaches Groningen').toBeGreaterThanOrEqual(53.7);
  const features = await rendered(page);
  const clusters = features.filter((f) => f.cluster);
  expect(clusters.length, 'clusters at the national view').toBeGreaterThan(0);
  expect(features.length, `${features.length} rendered features for ${all.length} points`).toBeLessThan(all.length / 4);
  const before = await zoomOf(page);
  await page.locator('#museum-map').scrollIntoViewIfNeeded();
  const box = await page.locator('#museum-map canvas').boundingBox();
  if (box === null) throw new Error('no canvas');
  // The biggest cluster that is clear of the canvas edge and of the zoom buttons (top right).
  const tappable = clusters.filter(
    (f) =>
      f.x > 40 && f.y > 40 && f.x < box.width - 40 && f.y < box.height - 40 && !(f.x > box.width - 100 && f.y < 140),
  );
  const biggest = tappable.reduce((a, b) => (b.count > a.count ? b : a));
  await page.mouse.click(box.x + biggest.x, box.y + biggest.y);
  await expect.poll(() => zoomOf(page), { message: 'the zoom after a tap on a cluster' }).toBeGreaterThan(before + 0.5);
  await expect(page.locator('#museum-map-card')).toHaveCount(0);
});

for (const locale of LOCALES) {
  test(`${locale}: a tap on a museum opens its card with a link to its page`, async ({ page, request }) => {
    // A museum whose coordinates no other museum shares, so a tap at a high zoom finds only it.
    const all = await points(request);
    const at = new Map<string, number>();
    for (const p of all) at.set(`${p.lat},${p.lon}`, (at.get(`${p.lat},${p.lon}`) ?? 0) + 1);
    const museum = all.find((p) => at.get(`${p.lat},${p.lon}`) === 1 && p.name_en !== null) as Point;
    await openMap(page, mapPath(locale));

    await page.evaluate(
      ([lon, lat]) =>
        new Promise<void>((resolve) => {
          const map = (document.getElementById('museum-map') as unknown as { mjkMap: import('maplibre-gl').Map })
            .mjkMap;
          map.once('idle', () => resolve());
          map.jumpTo({ center: [lon as number, lat as number], zoom: 15 });
        }),
      [museum.lon, museum.lat],
    );
    await expect.poll(async () => (await rendered(page)).some((f) => f.id === museum.slug)).toBe(true);
    const target = (await rendered(page)).find((f) => f.id === museum.slug);
    await page.locator('#museum-map').scrollIntoViewIfNeeded();
    const box = await page.locator('#museum-map canvas').boundingBox();
    if (target === undefined || box === null) throw new Error('no marker');
    await page.mouse.click(box.x + target.x, box.y + target.y);

    const card = page.locator('#museum-map-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(
      locale === 'en' ? (museum.name_en as string) : museum.name,
    );
    await expect(card.locator('a')).toHaveAttribute('href', museumPath(locale, museum.slug));
    await expect(card).toBeFocused();

    await page.locator('#museum-map-card-close').click();
    await expect(card).toHaveCount(0);
  });
}
