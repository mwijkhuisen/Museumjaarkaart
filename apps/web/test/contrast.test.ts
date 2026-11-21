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
