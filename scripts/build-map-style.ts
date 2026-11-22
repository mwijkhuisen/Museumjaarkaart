// Generates the MapLibre styles of the self-hosted basemap (A§15.3, ADR-0014) from the pinned
// @protomaps/basemaps layer set, one per UI language: apps/web/src/lib/map/styles/style-<lang>.json.
// Deterministic and offline, and nothing in a style names a host.
//
//   node scripts/build-map-style.ts           # rewrites the style files
//   node scripts/build-map-style.ts --check   # exit 1 if a committed file differs
//
// One vector source, `basemap`, whose url is the placeholder `pmtiles://basemap`: the client replaces
// it at run time with the tile file named by https://media.<domain>/tiles/current.json. Glyphs and
// sprite are root-relative (the client makes them absolute) and point at apps/web/public/map/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StyleSpecification, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor } from '@protomaps/basemaps';

export const ROOT = join(import.meta.dirname, '..');
export const STYLES_DIR = join(ROOT, 'apps/web/src/lib/map/styles');
export const styleFile = (lang: string) => join(STYLES_DIR, `style-${lang}.json`);

export const LANGS = ['nl', 'en'] as const;
export const ASSETS_COMMIT = '028c18f';
export const FLAVOUR = 'white';
export const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · Protomaps';

export function buildStyle(lang: string): StyleSpecification {
  const assets = `/map/${ASSETS_COMMIT}/`;
  return {
    version: 8,
    name: `basemap (${FLAVOUR}, ${lang})`,
    sources: { basemap: { type: 'vector', url: 'pmtiles://basemap', attribution: ATTRIBUTION } },
    glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assets}sprites/v4/${FLAVOUR}`,
    layers: layers('basemap', namedFlavor(FLAVOUR), { lang }),
  };
}

export const styleText = (style: StyleSpecification) => `${JSON.stringify(style, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--check')) {
    console.error('usage: node scripts/build-map-style.ts [--check]');
    process.exit(64);
  }
  for (const lang of LANGS) {
    const style = buildStyle(lang);
    const errors = validateStyleMin(style);
    if (errors.length > 0) {
      console.error(`build-map-style: style-${lang} is invalid: ${errors.map((e) => e.message).join('; ')}`);
      process.exit(1);
    }
    const text = styleText(style);
    const file = styleFile(lang);
    console.log(`style-${lang}.json: ${style.layers.length} layers`);
    if (args.length === 0) {
      mkdirSync(STYLES_DIR, { recursive: true });
      writeFileSync(file, text);
    } else {
      let current = '';
      try {
        current = readFileSync(file, 'utf8');
      } catch {}
      if (current !== text) {
        console.error(`build-map-style: ${file} is stale; run node scripts/build-map-style.ts`);
        process.exitCode = 1;
      }
    }
  }
}
