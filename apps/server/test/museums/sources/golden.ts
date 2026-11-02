// Shared helpers of the source tests: the fixtures, the golden files and a JSON
// layout that Biome keeps as it is (arrays of plain values on one line when they
// fit), so `vitest -u` output passes `biome check`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/museums/', import.meta.url));
export const CASES = ['normal', 'edge', 'empty', 'hostile'] as const;
/** Wikidata also keeps its hand-made edge cases, which the recorded `edge` replaced (O1). */
export const WIKIDATA_CASES = [...CASES, 'synthetic'] as const;
export type FixtureCase = (typeof WIKIDATA_CASES)[number];

export function fixturePath(source: 'wikidata' | 'rce', name: FixtureCase, ext: 'json' | 'meta.json' | 'golden.json') {
  return `${FIXTURE_DIR}${source}/${name}.${ext}`;
}

export function readFixture(source: 'wikidata' | 'rce', name: FixtureCase): unknown {
  return JSON.parse(readFileSync(fixturePath(source, name, 'json'), 'utf8'));
}

export function readMeta(source: 'wikidata' | 'rce', name: FixtureCase): unknown {
  return JSON.parse(readFileSync(fixturePath(source, name, 'meta.json'), 'utf8'));
}

const canInline = (v: unknown): boolean =>
  v === null || typeof v !== 'object' || (Array.isArray(v) && v.every(canInline));
const inline = (v: unknown): string => (Array.isArray(v) ? `[${v.map(inline).join(', ')}]` : JSON.stringify(v));

function layout(v: unknown, depth: number, prefixLength: number): string {
  const indent = '  '.repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (canInline(v)) {
      const line = inline(v);
      if (depth * 2 + prefixLength + line.length + 1 <= 120) return line;
    }
    return `[\n${v.map((x) => `${indent}  ${layout(x, depth + 1, 0)}`).join(',\n')}\n${indent}]`;
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    if (entries.length === 0) return '{}';
    const body = entries.map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return `${indent}  ${key}${layout(x, depth + 1, key.length)}`;
    });
    return `{\n${body.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/** The text of a golden file. */
export function goldenText(value: unknown): string {
  return `${layout(value, 0, 0)}\n`;
}

/** Every string in a value, keys included. */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const x of value) allStrings(x, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) {
      out.push(k);
      allStrings(x, out);
    }
  }
  return out;
}

/** Invisible and dangerous characters, by code point (the source holds no literal ones). */
const c = (...codes: number[]): string => String.fromCodePoint(...codes);
export const CH = {
  nul: c(0x0),
  nel: c(0x85),
  nbsp: c(0xa0),
  shy: c(0xad),
  zwsp: c(0x200b),
  zwj: c(0x200d),
  lrm: c(0x200e),
  rlm: c(0x200f),
  ls: c(0x2028),
  pdf: c(0x202c),
  lro: c(0x202d),
  rlo: c(0x202e),
  wj: c(0x2060),
  lri: c(0x2066),
  pdi: c(0x2069),
  bom: c(0xfeff),
  acute: c(0x301),
} as const;

const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/** Controls, bidi controls and zero-width characters: none may survive ingest. */
export const FORBIDDEN_CHARS = new RegExp(
  `[${FORBIDDEN_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`,
  'u',
);
