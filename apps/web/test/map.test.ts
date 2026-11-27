import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MuseumPoints } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import '../src/lib/zod.ts';
import { formatDistance } from '../src/lib/format.ts';
import { isFatalBasemapError, MapError } from '../src/lib/map/errors.ts';
import { markerImage, markOf, parseHex, pointsGeoJson, selectedOf } from '../src/lib/map/museumLayer.ts';
import { resolveStyle } from '../src/lib/map/resolveStyle.ts';
import { mediaOrigin, parseTilesPointer } from '../src/lib/map/tiles.ts';
import { roundPosition } from '../src/lib/near.ts';

const style = (lang: 'nl' | 'en') =>
  JSON.parse(readFileSync(new URL(`../src/lib/map/styles/style-${lang}.json`, import.meta.url), 'utf8')) as {
    glyphs: string;
    sprite: string;
    sources: Record<string, { url: string; type: string }>;
  };

describe('parseTilesPointer (tiles/current.json)', () => {
  it('takes the file and the previous one, or null', () => {
    expect(parseTilesPointer('{"file":"nl-20261101.pmtiles","previous":"nl-20260801.pmtiles"}')).toEqual({
      file: 'nl-20261101.pmtiles',
      previous: 'nl-20260801.pmtiles',
    });
    expect(parseTilesPointer('{"file":"nl-20261101.pmtiles","previous":null}').previous).toBeNull();
  });

  it.each([
    ['a path in the name', '{"file":"../nl-20261101.pmtiles","previous":null}'],
    ['a URL instead of a name', '{"file":"https://evil.example/nl-20261101.pmtiles","previous":null}'],
    ['a protocol-relative URL', '{"file":"//evil.example/nl-20261101.pmtiles","previous":null}'],
    ['a short build number', '{"file":"nl-2026.pmtiles","previous":null}'],
    ['another extension', '{"file":"nl-20261101.pmtiles.js","previous":null}'],
    ['a trailing newline in the name', '{"file":"nl-20261101.pmtiles\\n","previous":null}'],
    ['a bad previous', '{"file":"nl-20261101.pmtiles","previous":"https://evil.example/x"}'],
    ['a missing previous', '{"file":"nl-20261101.pmtiles"}'],
    ['an extra key', '{"file":"nl-20261101.pmtiles","previous":null,"url":"https://evil.example/"}'],
    ['a number', '{"file":20261101,"previous":null}'],
    ['an array', '[]'],
    ['null', 'null'],
    ['not JSON', '<html>'],
    ['empty', ''],
  ])('refuses %s', (_name, body) => {
    expect(() => parseTilesPointer(body)).toThrow(MapError);
    try {
      parseTilesPointer(body);
    } catch (err) {
      expect((err as MapError).code).toBe('tiles_pointer_invalid');
    }
  });
});

describe('isFatalBasemapError (MapLibre error events during load)', () => {
  it('fails the map for an error of the basemap source itself, never for one tile or another source', () => {
    const error = new Error('x');
    expect(isFatalBasemapError({ type: 'error', error, sourceId: 'basemap' })).toBe(true);
    expect(isFatalBasemapError({ type: 'error', error, sourceId: 'basemap', tile: { state: 'errored' } })).toBe(false);
    expect(isFatalBasemapError({ type: 'error', error, sourceId: 'museums' })).toBe(false);
    expect(isFatalBasemapError({ type: 'error', error })).toBe(false);
    expect(isFatalBasemapError(null)).toBe(false);
  });
});

describe('resolveStyle', () => {
  const origin = 'https://mjk.test';
  const media = mediaOrigin('mjk.test');
  const file = 'nl-20261101.pmtiles';

  it.each(['nl', 'en'] as const)('makes the %s style absolute, with the tiles on media.<domain>', (lang) => {
    const base = style(lang);
    const out = resolveStyle(base, file, origin, media);
    expect(out.sources.basemap?.url).toBe('pmtiles://https://media.mjk.test/tiles/nl-20261101.pmtiles');
    expect(out.glyphs).toBe(`${origin}${base.glyphs}`);
    expect(out.glyphs).toContain('{fontstack}/{range}.pbf');
    expect(out.sprite).toBe(`${origin}${base.sprite}`);
    // Nothing else in the style names a host.
    const rest = JSON.stringify({ ...out, sources: undefined });
    expect([...rest.matchAll(/https?:\/\/[^/"]+/g)].map((m) => m[0])).toEqual([origin, origin]);
    // The input is untouched.
    expect(base.sources.basemap?.url).toBe('pmtiles://basemap');
    expect(base.glyphs.startsWith('/')).toBe(true);
  });

  it('refuses a style with another or a second source', () => {
    const base = style('nl');
    const other = { ...base, sources: { planet: base.sources.basemap as { url: string; type: string } } };
    expect(() => resolveStyle(other, file, origin, media)).toThrow(MapError);
    const two = {
      ...base,
      sources: { ...base.sources, extra: { url: 'https://evil.example/t.json', type: 'vector' } },
    };
    expect(() => resolveStyle(two, file, origin, media)).toThrow(MapError);
  });

  it.each([
    [
      'a tile source that is not the placeholder',
      (s: ReturnType<typeof style>) => (s.sources.basemap = { type: 'vector', url: 'https://evil.example/t.json' }),
    ],
    [
      'glyphs on another host',
      (s: ReturnType<typeof style>) => (s.glyphs = 'https://evil.example/{fontstack}/{range}.pbf'),
    ],
    [
      'protocol-relative glyphs',
      (s: ReturnType<typeof style>) => (s.glyphs = '//evil.example/{fontstack}/{range}.pbf'),
    ],
    ['a sprite on another host', (s: ReturnType<typeof style>) => (s.sprite = 'https://evil.example/sprite')],
    ['no glyphs', (s: ReturnType<typeof style>) => Reflect.deleteProperty(s, 'glyphs')],
  ])('refuses %s', (_name, mutate) => {
    const bad = structuredClone(style('nl'));
    mutate(bad);
    expect(() => resolveStyle(bad, file, origin, media)).toThrow(MapError);
  });

  it.each([
    ['an origin with a path', 'https://mjk.test/x', media, file],
    ['a media origin that is not media.*', origin, 'https://evil.example', file],
    ['a plain-http media origin', origin, 'http://media.mjk.test', file],
    ['a media origin with a path', origin, 'https://media.mjk.test/tiles', file],
    ['a file that is a URL', origin, media, 'https://evil.example/nl-20261101.pmtiles'],
  ])('refuses %s', (_name, o, m, f) => {
    expect(() => resolveStyle(style('nl'), f, o, m)).toThrow(MapError);
  });
});

describe('roundPosition (near me)', () => {
  it.each<[number, number, string, string]>([
    [52.3731234, 4.8901234, '52.373', '4.890'],
    [52.3736, 4.8906, '52.374', '4.891'],
    [52, 5, '52.000', '5.000'],
    [-0.0004, -0.0004, '0.000', '0.000'],
    [-0.0006, -12.34567, '-0.001', '-12.346'],
    [90, 180, '90.000', '180.000'],
    [-90, -180, '-90.000', '-180.000'],
    [51.9999999, 4.0004999, '52.000', '4.000'],
  ])('(%s, %s) is (%s, %s)', (lat, lon, expectedLat, expectedLon) => {
    expect(roundPosition(lat, lon)).toEqual({ lat: expectedLat, lon: expectedLon });
  });

  it('never gives more than 3 decimals, over many positions', () => {
    for (let i = 0; i < 2000; i++) {
      const lat = 50.7 + ((i * 7919) % 3000) / 1000 + (i % 13) / 1e7;
      const lon = 3.2 + ((i * 104729) % 4100) / 1000 + (i % 17) / 1e9;
      const at = roundPosition(lat, lon);
      expect(at.lat).toMatch(/^-?[0-9]{1,2}\.[0-9]{3}$/);
      expect(at.lon).toMatch(/^-?[0-9]{1,3}\.[0-9]{3}$/);
    }
  });

  it.each([
    [Number.NaN, 5],
    [52, Number.POSITIVE_INFINITY],
    [91, 5],
    [52, -181],
    [1e21, 5],
  ])('refuses (%s, %s)', (lat, lon) => {
    expect(() => roundPosition(lat, lon)).toThrow(RangeError);
  });
});

describe('formatDistance', () => {
  it.each<[number, 'nl' | 'en', string]>([
    [0, 'nl', '0 m'],
    [450, 'nl', '450 m'],
    [999, 'en', '999 m'],
    [1000, 'nl', '1 km'],
    [12_345, 'nl', '12,3 km'],
    [12_345, 'en', '12.3 km'],
    [150_000, 'nl', '150 km'],
  ])('%s m in %s', (metres, locale, expected) => {
    expect(formatDistance(metres, locale)).toBe(expected);
  });
});

describe('the museum layer helpers', () => {
  const points = MuseumPoints.parse({
    items: [
      {
        id: '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11',
        slug: 'a-museum',
        name: '<img src=x onerror=alert(1)>',
        name_en: null,
        lat: 52.1,
        lon: 5.2,
        museumkaart_status: 'participating',
        categories: ['art'],
      },
    ],
  });

  it('puts only the card fields in the properties, as text, longitude first', () => {
    const [feature] = pointsGeoJson(points).features;
    expect(feature?.geometry.coordinates).toEqual([5.2, 52.1]);
    expect(feature?.properties).toEqual({
      slug: 'a-museum',
      name: '<img src=x onerror=alert(1)>',
      status: 'participating',
    });
  });

  it("adds a `mark` property only for the member's own museums, visited before wishlist", () => {
    const id = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';
    const sets = (visited: string[], wishlist: string[]) => ({
      visited: new Set(visited),
      wishlist: new Set(wishlist),
    });
    expect(markOf(id, undefined)).toBeUndefined();
    expect(markOf(id, sets([], []))).toBeUndefined();
    expect(markOf(id, sets([], [id]))).toBe('wishlist');
    expect(markOf(id, sets([id], [id]))).toBe('visited');
    expect(pointsGeoJson(points, sets([id], [])).features[0]?.properties).toMatchObject({ mark: 'visited' });
    expect(pointsGeoJson(points, sets([], [])).features[0]?.properties).not.toHaveProperty('mark');
  });

  it('reads the card from properties, and nothing else', () => {
    expect(selectedOf({ slug: 'a', name: 'B', status: 'left' })).toEqual({ slug: 'a', name: 'B', status: 'left' });
    expect(selectedOf({ slug: 'a', name: 'B', status: 'x' })).toBeNull();
    expect(selectedOf({ slug: 1, name: 'B', status: 'left' })).toBeNull();
    expect(selectedOf({ cluster: true, point_count: 4 })).toBeNull();
    expect(selectedOf(null)).toBeNull();
  });

  it('parses #rrggbb only', () => {
    expect(parseHex('#9a3d00')).toEqual([154, 61, 0]);
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#A3c')).toEqual([170, 51, 204]);
    for (const bad of ['', '9a3d00', '#9a3d0', '#ffff', 'red', 'rgb(1,2,3)', '#9a3d00ff'])
      expect(() => parseHex(bad)).toThrow(MapError);
  });

  describe('markerImage', () => {
    it('draws the square and the triangle, each filled in the middle and different from the others', () => {
      const fill = [10, 20, 30] as const;
      const ring = [250, 240, 230] as const;
      const at = (img: ReturnType<typeof markerImage>, x: number, y: number) => img.data[(y * 56 + x) * 4 + 3];
      const draw = (shape: Parameters<typeof markerImage>[0]) => markerImage(shape, fill, ring, 56);
      const circle = draw('circle');
      const diamond = draw('diamond');
      const square = draw('square');
      const triangle = draw('triangle');
      // The square reaches into the corner region where the circle and the diamond are empty.
      expect(at(square, 6, 6)).toBe(255);
      expect(at(circle, 6, 6)).toBe(0);
      expect(at(diamond, 6, 6)).toBe(0);
      // The triangle: apex up, wide base. Top corners empty, bottom corners filled.
      expect(at(triangle, 28, 36)).toBe(255);
      expect(at(triangle, 12, 8)).toBe(0);
      expect(at(triangle, 8, 50)).toBeGreaterThan(0);
      const images = [circle, diamond, square, triangle];
      for (const a of images) for (const b of images) if (a !== b) expect(Buffer.compare(a.data, b.data)).not.toBe(0);
    });

    const fill = [10, 20, 30] as const;
    const ring = [250, 240, 230] as const;
    const size = 56;
    const px = (img: ReturnType<typeof markerImage>, x: number, y: number) => [
      ...img.data.slice((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];

    it('is size x size RGBA with the fill in the middle and the ring colour near the edge', () => {
      for (const shape of ['circle', 'diamond'] as const) {
        const img = markerImage(shape, fill, ring, size);
        expect([img.width, img.height, img.data.length]).toEqual([size, size, size * size * 4]);
        expect(px(img, 28, 28)).toEqual([10, 20, 30, 255]);
      }
      // The circle's left edge (inside, within the ring) is ring-coloured and opaque.
      expect(px(markerImage('circle', fill, ring, size), 2, 28)).toEqual([250, 240, 230, 255]);
    });

    it('differs by shape: the corner is empty for both, the diamond is empty where the circle is filled', () => {
      const circle = markerImage('circle', fill, ring, size);
      const diamond = markerImage('diamond', fill, ring, size);
      expect(px(circle, 0, 0)[3]).toBe(0);
      expect(px(diamond, 0, 0)[3]).toBe(0);
      // Along the diagonal the circle reaches further than the diamond.
      expect(px(circle, 12, 12)[3]).toBe(255);
      expect(px(diamond, 12, 12)[3]).toBe(0);
      // Along an axis the diamond reaches its tip.
      expect(px(diamond, 28, 2)[3]).toBeGreaterThan(0);
      expect(Buffer.compare(circle.data, diamond.data)).not.toBe(0);
    });
  });
});

describe('the lazy chunk (A§15.3)', () => {
  it('createMap.ts is the only source file that imports maplibre-gl or pmtiles', () => {
    const root = new URL('../src/', import.meta.url).pathname;
    const files = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const offenders: string[] = [];
    for (const file of files('').filter((f) => !f.startsWith('paraglide'))) {
      const text = readFileSync(join(root, file), 'utf8');
      // `import type` is erased; a value import (or a side-effect import) pulls the library in.
      for (const line of text.split('\n')) {
        if (/^import\s/.test(line) && /['"](maplibre-gl|pmtiles)[/'"]/.test(line) && !/^import type\s/.test(line)) {
          offenders.push(`${file}: ${line}`);
        }
      }
    }
    expect(offenders.map((o) => o.split(':')[0])).toEqual(
      Array(offenders.length).fill(join('lib', 'map', 'createMap.ts')),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });
});
