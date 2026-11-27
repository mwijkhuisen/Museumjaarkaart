import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// sharp and libvips load only in the `media` role (P3b plan §1 Q1): process.ts is the one importer of sharp,
// role.ts the one importer of process.ts, and main.ts reaches role.ts only through a dynamic import, so the api,
// ssr and worker processes never load them.

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

const files = (readdirSync(SRC, { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => join(SRC, f));

/** Every import specifier of a file, static and dynamic. */
function imports(file: string): { spec: string; dynamic: boolean }[] {
  const text = readFileSync(file, 'utf8');
  const out: { spec: string; dynamic: boolean }[] = [];
  for (const m of text.matchAll(/\b(from|import)\s*(\(\s*)?['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[3] as string, dynamic: m[2] !== undefined });
  }
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g))
    out.push({ spec: m[1] as string, dynamic: true });
  return out;
}

const target = (file: string, spec: string) => (spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
const importersOf = (what: string) =>
  files
    .filter((f) => imports(f).some((i) => target(f, i.spec) === what))
    .map((f) => relative(SRC, f))
    .sort();

describe('the media role is the only process that loads sharp', () => {
  it('only media/process.ts imports sharp', () => {
    expect(importersOf('sharp')).toEqual(['media/process.ts']);
  });

  it('only media/role.ts imports media/process.ts', () => {
    expect(importersOf(join(SRC, 'media/process.ts'))).toEqual(['media/role.ts']);
  });

  it('main.ts reaches media/role.ts only through a dynamic import, and nothing else imports it', () => {
    const role = join(SRC, 'media/role.ts');
    expect(importersOf(role)).toEqual(['main.ts']);
    const main = join(SRC, 'main.ts');
    expect(imports(main).filter((i) => target(main, i.spec) === role)).toEqual([
      { spec: './media/role.ts', dynamic: true },
    ]);
  });

  it('media/role.ts imports nothing of the database, auth, mail, api or R2', () => {
    const role = join(SRC, 'media/role.ts');
    for (const i of imports(role)) {
      expect(target(role, i.spec)).not.toMatch(/\/src\/(db|auth|mail|api)\/|\/r2\.ts$|^pg$|^kysely$/);
    }
  });
});
