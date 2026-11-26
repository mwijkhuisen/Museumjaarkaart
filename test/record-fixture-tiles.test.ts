import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OUT, parseArgs, refuseUnderCi } from '../scripts/record-fixture-tiles.ts';

// P1d Q6: the fixture-tiles recorder runs on the owner's machine only, never under CI.

const script = fileURLToPath(new URL('../scripts/record-fixture-tiles.ts', import.meta.url));
const run = (args: string[], env: Record<string, string | undefined>) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

describe('record-fixture-tiles', () => {
  it.each(['', 'false', '0', '1'])('exits 3 with CI=%j before it runs any binary', (ci) => {
    // A binary that does not exist: had the script got as far as running it, the exit would be another.
    const r = run(['--pmtiles', '/nonexistent/pmtiles', '--build', '20261001'], { CI: ci });
    expect(r.status).toBe(3);
    expect(r.stderr.trim()).toBe('record-fixture-tiles: refusing to run under CI (it runs on the owner machine only)');
  });

  it('refuses whenever CI is set, and not when it is unset', () => {
    expect(refuseUnderCi({ CI: '' })).toBeDefined();
    expect(refuseUnderCi({})).toBeUndefined();
  });

  it('exits 64 with the usage line for bad arguments (CI unset)', () => {
    const r = run(['--build', '2026-10-01'], {});
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('usage: node scripts/record-fixture-tiles.ts');
  });

  it('parses its three options and nothing else', () => {
    expect(parseArgs(['--pmtiles', '/bin/pmtiles', '--build', '20261122'])).toEqual({
      pmtiles: '/bin/pmtiles',
      build: '20261122',
      out: DEFAULT_OUT,
    });
    expect(parseArgs(['--pmtiles', 'p', '--build', '20261122', '--out', '/tmp/x'])?.out).toBe('/tmp/x');
    for (const bad of [
      [],
      ['--build', '20261122'],
      ['--pmtiles', 'p', '--build', '1122'],
      ['--pmtiles', 'p', '--build', '20261122', '--bbox', '1,2,3,4'],
      ['--pmtiles', 'p', '--pmtiles', 'q', '--build', '20261122'],
      ['--pmtiles'],
    ]) {
      expect(parseArgs(bad), bad.join(' ')).toBeUndefined();
    }
  });
});
