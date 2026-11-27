import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// P2b code review: the `ssr` role never loads @simplewebauthn/server, nor reflect-metadata, which
// patches the global `Reflect` on import. A child node process (a clean module graph, unlike the
// test runner's) imports a module and reports every URL its resolve hook saw, and whether
// `Reflect.getMetadata` exists. main.ts is what `node main.ts ssr` loads (it imports every role
// module), ssr/server.ts and ssr/app.ts what the role runs; create-app.ts is the control, so a probe
// that saw nothing cannot pass.

const PROBE = `
import { registerHooks } from 'node:module';
const seen = [];
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    seen.push(r.url);
    return r;
  },
});
await import(process.argv[1]);
console.log(JSON.stringify({ seen, getMetadata: typeof Reflect.getMetadata }));
`;

type Probe = { seen: string[]; getMetadata: string };

function probe(path: string): Probe {
  const url = new URL(path, import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', PROBE, url], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 30_000,
  });
  return JSON.parse(out.trim().split('\n').at(-1) as string) as Probe;
}

const library = (p: Probe) => p.seen.filter((u) => /\/(@simplewebauthn|reflect-metadata|tsyringe)\//.test(u));

describe('the ssr role’s module graph', () => {
  it.each(['../../src/main.ts', '../../src/ssr/server.ts', '../../src/ssr/app.ts'])(
    '%s loads no @simplewebauthn, tsyringe or reflect-metadata, and leaves Reflect alone',
    (path) => {
      const p = probe(path);
      expect(p.seen.some((u) => u.includes('/src/api/app.ts'))).toBe(true);
      expect(library(p)).toEqual([]);
      expect(p.seen.filter((u) => u.includes('/src/api/create-app.ts'))).toEqual([]);
      expect(p.getMetadata).toBe('undefined');
    },
    30_000,
  );

  it('control: the api role’s create-app.ts loads the library and its Reflect patch', () => {
    const p = probe('../../src/api/create-app.ts');
    expect(library(p).some((u) => u.includes('/@simplewebauthn/server/'))).toBe(true);
    expect(p.getMetadata).toBe('function');
  }, 30_000);
});
