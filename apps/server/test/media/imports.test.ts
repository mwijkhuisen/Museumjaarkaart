import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// sharp and libvips load only in the `media` role's single-use child (P3b plan §1 Q1, security review M2 b):
// process.ts is the one importer of sharp, task-child.ts the one importer of process.ts and is imported by nothing
// (the role forks it by URL), and main.ts reaches role.ts only through a dynamic import, so the api, ssr, worker
// and even the role's own process never load them.

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

  it('only media/task-child.ts imports media/process.ts, and nothing imports the child', () => {
    expect(importersOf(join(SRC, 'media/process.ts'))).toEqual(['media/task-child.ts']);
    expect(importersOf(join(SRC, 'media/task-child.ts'))).toEqual([]);
    expect(readFileSync(join(SRC, 'media/role.ts'), 'utf8')).toContain("new URL('./task-child.ts', import.meta.url)");
  });

  it('main.ts reaches media/role.ts only through a dynamic import, and nothing else imports it', () => {
    const role = join(SRC, 'media/role.ts');
    expect(importersOf(role)).toEqual(['main.ts']);
    const main = join(SRC, 'main.ts');
    expect(imports(main).filter((i) => target(main, i.spec) === role)).toEqual([
      { spec: './media/role.ts', dynamic: true },
    ]);
  });

  it('media/role.ts and its child import nothing of the database, auth, mail, api or R2', () => {
    for (const f of ['media/role.ts', 'media/task-child.ts', 'media/task.ts']) {
      const file = join(SRC, f);
      for (const i of imports(file)) {
        expect(target(file, i.spec)).not.toMatch(/\/src\/(db|auth|mail|api)\/|\/r2\.ts$|^pg$|^kysely$/);
      }
    }
  });
});
