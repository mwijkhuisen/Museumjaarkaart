import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { LOCALES, mapPath, openMap } from './helpers.ts';

// P1d criterion "Playwright on fixture tiles from the S3 stand-in under the production CSP" (A§15.3, A§18): the map
// renders on /kaart and /en/map, its canvas is not blank, its worker is a same-origin URL, the tiles come from
// media.<domain> with Range (206), the attribution is our fixed text and no list or museum page loads MapLibre.
// The guard (fixtures.ts) fails each test on a CSP violation, a request to any host but <domain> and
// media.<domain>, and a console error or warning.

const MAP_CHUNK = /\/assets\/(createMap|maplibre-gl-worker|style-nl|style-en)-[^/]+\.(js|css)$/;

/**
 * The number of distinct colours (5 bits per channel) of the basemap: the museum layers are hidden, then the canvas
 * is copied inside a render frame. The map has no `preserveDrawingBuffer`, so the buffer is only readable until the
 * frame is presented; and a Playwright screenshot is no way in WebKit, where it injects an inline <style> that the
 * CSP (rightly) blocks.
 */
const colourCount = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const map = (document.getElementById('museum-map') as { mjkMap?: import('maplibre-gl').Map } | null)?.mjkMap;
        if (map === undefined) return reject(new Error('no map'));
        for (const layer of ['museum-clusters', 'museum-cluster-count', 'museum-points'])
          map.setLayoutProperty(layer, 'visibility', 'none');
        map.once('idle', () => {
          map.once('render', () => {
            const canvas = map.getCanvas();
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const ctx = copy.getContext('2d') as CanvasRenderingContext2D;
            ctx.drawImage(canvas, 0, 0);
            const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
            const seen = new Set<number>();
            for (let i = 0; i < data.length; i += 4)
              seen.add(((data[i] ?? 0) >> 3) | (((data[i + 1] ?? 0) >> 3) << 5) | (((data[i + 2] ?? 0) >> 3) << 10));
            resolve(seen.size);
          });
          map.triggerRepaint();
        });
        map.triggerRepaint();
      }),
  );

for (const locale of LOCALES) {
  test(`${locale}: the map is ready, drawn, same-origin and served in ranges by media.<domain>`, async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    const requests: string[] = [];
    const tiles: { url: string; status: number }[] = [];
    const workers: string[] = [];
    page.on('request', (req) => requests.push(req.url()));
    page.on('response', (res) => {
      if (res.url().startsWith('https://media.mjk.test/tiles/')) tiles.push({ url: res.url(), status: res.status() });
    });
    page.on('worker', (w) => workers.push(w.url()));

    await openMap(page, mapPath(locale));
    await expect(page.locator('#museum-map-status')).toHaveText('');

    // MapLibre came as the lazy chunk, and its worker is a same-origin module URL, never blob: (A§15.6).
    expect(requests.filter((u) => MAP_CHUNK.test(u)).length, 'the map chunk and the worker').toBeGreaterThanOrEqual(2);
    expect(workers.length, 'a worker started').toBeGreaterThan(0);
    for (const url of workers) {
      expect(url).not.toMatch(/^blob:/);
      expect(url).toMatch(new RegExp(`^${origin}/assets/maplibre-gl-worker-[^/]+\\.js$`));
    }

    // The pointer and the archive's header and tiles: media.<domain>/tiles/ answered, with a 206 for a Range.
    expect(tiles.map((t) => new URL(t.url).pathname)).toContain('/tiles/current.json');
    expect(
      tiles.some((t) => t.status === 206),
      `a 206 among ${JSON.stringify(tiles.map((t) => t.status))}`,
    ).toBe(true);
    expect(tiles.every((t) => t.status === 200 || t.status === 206)).toBe(true);

    // Not blank: the basemap and the markers give more than one colour.
    expect(await colourCount(page)).toBeGreaterThan(2);

    // The attribution is our own plain text, never the archive's HTML.
    await expect(page.locator('#museum-map .maplibregl-ctrl-attrib')).toContainText(
      '© OpenStreetMap contributors · Protomaps',
    );
    expect(await page.locator('#museum-map .maplibregl-ctrl-attrib a').count()).toBe(0);
  });
}

test('the list, search and museum pages never load MapLibre or the tiles', async ({ page, request }) => {
  const list = (await (await request.get('/api/v1/museums?limit=1')).json()) as { items: { slug: string }[] };
  const slug = list.items[0]?.slug ?? '';
  for (const path of ['/musea', '/en/museums', `/musea/${slug}`, '/zoeken?q=museum', '/']) {
    const requests: string[] = [];
    const onRequest = (req: { url(): string }) => requests.push(req.url());
    page.on('request', onRequest);
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    page.off('request', onRequest);
    expect(requests.length, path).toBeGreaterThan(1);
    expect(
      requests.filter((u) => /maplibre|pmtiles/i.test(u) || MAP_CHUNK.test(u) || new URL(u).host.startsWith('media.')),
      `${path} requests the map`,
    ).toEqual([]);
  }
});
