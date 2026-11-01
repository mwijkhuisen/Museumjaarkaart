import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('exports src by default and dist under the mjk-dist condition', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: unknown };
  expect(pkg.exports).toEqual({ '.': { 'mjk-dist': './dist/index.js', default: './src/index.ts' } });
});

it('resolves the package by self-reference to src', () => {
  expect(import.meta.resolve('@mjk/contracts')).toMatch(/\/packages\/contracts\/src\/index\.ts$/);
});
