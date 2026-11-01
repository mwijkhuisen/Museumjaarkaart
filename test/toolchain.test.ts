import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

it('names the same Node and pnpm versions everywhere', () => {
  const pkg = JSON.parse(read('package.json')) as { engines: { node: string }; packageManager: string };
  expect(read('.node-version').trim()).toBe('26.10.0');
  expect(pkg.engines.node).toBe(`>=${read('.node-version').trim()} <27`);
  expect(pkg.packageManager.startsWith('pnpm@12.5.1+sha512.')).toBe(true);
  expect(read('scripts/install-pnpm.sh')).toMatch(/^readonly VERSION=12\.5\.1$/m);
});
