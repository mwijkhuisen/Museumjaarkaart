import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION, buildStyle, LANGS, ROOT, styleFile, styleText } from '../scripts/build-map-style.ts';

// A§15.3, ADR-0014: the two committed styles come from scripts/build-map-style.ts, name no host, and every
// glyph and sprite file they reference is under apps/web/public/map/.

const MAP = join(ROOT, 'apps/web/public/map');
const ASSETS = join(MAP, '028c18f');

type Style = ReturnType<typeof buildStyle>;
const committed = (lang: string): Style => JSON.parse(readFileSync(styleFile(lang), 'utf8'));

/** Every string in a JSON value. */
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
}

/** The font names a style's `text-font` values hold (plain stacks and expressions). */
function fontNames(style: Style): string[] {
  const names = new Set<string>();
  for (const l of style.layers) {
    const font = (l as { layout?: { 'text-font'?: unknown } }).layout?.['text-font'];
    if (font === undefined) continue;
    for (const s of strings(font)) if (s.startsWith('Noto')) names.add(s);
  }
  return [...names].sort();
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe.each(LANGS)('style-%s.json', (lang) => {
  it('is the generator output (not stale)', () => {
    expect(readFileSync(styleFile(lang), 'utf8')).toBe(styleText(buildStyle(lang)));
  });

  it('validates against the style spec', () => {
    expect(validateStyleMin(committed(lang))).toEqual([]);
  });

  it('has the one basemap source, root-relative glyphs and sprite, and no host', () => {
    const style = committed(lang);
    expect(style.sources).toEqual({ basemap: { type: 'vector', url: 'pmtiles://basemap', attribution: ATTRIBUTION } });
    expect(style.glyphs).toBe('/map/028c18f/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('/map/028c18f/sprites/v4/white');
    for (const s of strings(style)) {
      if (s === 'pmtiles://basemap' || s === ATTRIBUTION) continue;
      expect(s, 'a host in the style').not.toContain('://');
    }
    // The attribution's one link is the only other `://`.
    expect(ATTRIBUTION.match(/:\/\//g)).toHaveLength(1);
  });

  it('references only fonts and sprites that exist', () => {
    const names = fontNames(committed(lang));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const dir = join(ASSETS, 'fonts', name);
      const got = readdirSync(dir).sort();
      const want = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}.pbf`).sort();
      expect(got, name).toEqual(want);
    }
    for (const f of ['white.json', 'white.png', 'white@2x.json', 'white@2x.png']) {
      expect(existsSync(join(ASSETS, 'sprites/v4', f)), f).toBe(true);
    }
    expect(existsSync(join(ASSETS, 'fonts/OFL.txt'))).toBe(true);
  });
});

describe('labels', () => {
  it('the NL style labels with name:nl and the EN style with name:en', () => {
    const nl = readFileSync(styleFile('nl'), 'utf8');
    const en = readFileSync(styleFile('en'), 'utf8');
    expect(nl).toContain('name:nl');
    expect(en).toContain('name:en');
    expect(en).not.toContain('name:nl');
  });
});

describe('public/map', () => {
  it('copies exactly the fonts the styles name', () => {
    const used = new Set(LANGS.flatMap((l) => fontNames(committed(l))));
    expect(
      readdirSync(join(ASSETS, 'fonts'))
        .filter((n) => n !== 'OFL.txt')
        .sort(),
    ).toEqual([...used].sort());
  });

  it('lists every file in SHA256SUMS with its hash', () => {
    const sums = new Map(
      readFileSync(join(ASSETS, 'SHA256SUMS'), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => [line.slice(66), line.slice(0, 64)] as const),
    );
    const found = files(MAP)
      .map((f) => relative(ASSETS, f))
      .filter((f) => f !== 'SHA256SUMS')
      .sort();
    expect([...sums.keys()].sort()).toEqual(found);
    for (const f of found) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(ASSETS, f)))
          .digest('hex'),
        f,
      ).toBe(sums.get(f));
    }
  });
});
