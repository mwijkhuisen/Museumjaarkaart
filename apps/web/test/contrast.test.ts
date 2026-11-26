import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? '').trim()]),
  );
}
const light = tokens(css.match(/^:root \{([^}]*)\}/m)?.[1] ?? '');
const dark = tokens(css.match(/prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/)?.[1] ?? '');

function lum(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a = '', b = ''): number {
  const [hi = 0, lo = 0] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The badge draws its word in the --color-mk-* colour, so those are text (4.5:1) as well as UI parts.
const text = [
  '--color-text',
  '--color-text-muted',
  '--color-link',
  '--color-mk-participating',
  '--color-mk-left',
  '--color-mk-unknown',
  '--color-danger',
];
const ui = ['--color-border-strong', '--color-focus'];
const bgs = ['--color-bg', '--color-surface'];
const required = [...text, ...ui, ...bgs, '--color-accent', '--color-accent-text', '--color-danger'];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme', (_name, t) => {
  it('has every token as #rrggbb', () => {
    for (const k of required) expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('text pairs reach 4.5:1', () => {
    for (const bg of bgs) for (const k of text) expect(ratio(t[k], t[bg]), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['--color-accent-text'], t['--color-accent'])).toBeGreaterThanOrEqual(4.5);
  });
  it('UI pairs reach 3:1', () => {
    for (const bg of bgs) for (const k of ui) expect(ratio(t[k], t[bg]), `${k} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});

// The map markers (A§15.3, A§15.5): the basemap is always the light flavour, also in dark mode, so
// the markers are one set of tokens in :root and are checked against every fill colour of the
// generated style (land, water, parks, buildings, ...), not against the page background.
describe('map markers on the light basemap', () => {
  const style = JSON.parse(readFileSync(new URL('../src/lib/map/styles/style-nl.json', import.meta.url), 'utf8')) as {
    layers: { id: string; type: string; paint?: Record<string, unknown> }[];
  };
  const fills = new Map<string, string>();
  for (const layer of style.layers) {
    const text = JSON.stringify(layer.paint?.['fill-color'] ?? layer.paint?.['background-color']) ?? '';
    for (const m of text.matchAll(/#[0-9a-f]{6}/gi))
      fills.set(m[0].toLowerCase(), `${fills.get(m[0].toLowerCase()) ?? ''} ${layer.id}`);
    for (const m of text.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) {
      const hex = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
      fills.set(hex, `${fills.get(hex) ?? ''} ${layer.id}`);
    }
  }
  const markers = ['--color-map-mk', '--color-map-other', '--color-map-cluster'];

  it('has the tokens as #rrggbb, in the light block only (never overridden in dark mode)', () => {
    for (const k of [...markers, '--color-map-outline']) {
      expect(light[k], k).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark[k], k).toBeUndefined();
    }
  });

  it('reads the land and the water of the style', () => {
    expect(fills.get('#e2dfda')).toContain(' earth');
    expect(fills.get('#80deea')).toContain(' water');
    expect(fills.size).toBeGreaterThan(10);
  });

  it('each marker is 3:1 against every basemap fill', () => {
    for (const k of markers) {
      for (const [bg, layer] of fills) expect(ratio(light[k], bg), `${k} on ${layer} ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('each marker is 3:1 against its outline, and the cluster count is 4.5:1 text', () => {
    for (const k of markers) expect(ratio(light[k], light['--color-map-outline']), k).toBeGreaterThanOrEqual(3);
    expect(ratio(light['--color-map-outline'], light['--color-map-cluster'])).toBeGreaterThanOrEqual(4.5);
  });

  it('the Museumkaart marker and the others differ in colour as well as shape', () => {
    expect(light['--color-map-mk']).not.toBe(light['--color-map-other']);
  });
});
