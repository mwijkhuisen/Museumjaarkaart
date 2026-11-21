import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// P1c criterion 8: the shortlisted brand names (A§1) never reach the code; the brand is configuration.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NAMES = /muselog|muzelog|museumvink|museumlog/i;

it('no shortlisted brand name in a tracked file under apps/', () => {
  const files = execFileSync('git', ['ls-files', 'apps'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const hits = files.filter((f) => {
    try {
      return NAMES.test(readFileSync(`${ROOT}${f}`, 'utf8'));
    } catch {
      return false;
    }
  });
  expect(hits).toEqual([]);
});

it('the matcher catches each name in any case', () => {
  for (const s of ['MuseLog', 'MUZELOG', 'museumVINK', 'Museumlog']) expect(NAMES.test(s)).toBe(true);
  expect(NAMES.test('Testmerk')).toBe(false);
});
