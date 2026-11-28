import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeTree } from '../../src/media/remove-tree.ts';

// Removing a tree another container can change mid-walk (P3b security review M1, code review M1): no depth cap
// short of 256 levels, no path-based recursion, and a directory swapped for a link between the type check and the
// descent is unlinked, never followed. The swap is made deterministic by a hook on `open`.

const hook = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      await hook.beforeOpen?.(String(args[0]));
      return real.open(...args);
    },
  };
});

let base: string;
let outside: string;
beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'mjk-rmtree-'));
  outside = await fsp.mkdtemp(join(tmpdir(), 'mjk-rmtree-outside-'));
  await fsp.mkdir(join(outside, 'sub'));
  await fsp.writeFile(join(outside, 'keep'), 'x');
  await fsp.writeFile(join(outside, 'sub', 'keep'), 'x');
});
afterEach(async () => {
  hook.beforeOpen = undefined;
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

const outsideIntact = () => existsSync(join(outside, 'keep')) && existsSync(join(outside, 'sub', 'keep'));

it('removes a tree deeper than the old limit of 4, with a link mid-tree whose target survives', async () => {
  const top = join(base, 'task');
  let d = top;
  for (let i = 0; i < 20; i++) {
    d = join(d, `d${i}`);
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(join(d, 'f'), 'x');
    if (i === 10) await fsp.symlink(outside, join(d, 'link'));
  }
  await removeTree(top);
  expect(existsSync(top)).toBe(false);
  expect(outsideIntact()).toBe(true);
});

it('unlinks a directory swapped for a link between the type check and the descent; the target survives', async () => {
  const top = join(base, 'task');
  const victim = join(top, 'a', 'b');
  await fsp.mkdir(victim, { recursive: true });
  await fsp.writeFile(join(victim, 'f'), 'x');
  let swapped = false;
  hook.beforeOpen = async (path) => {
    // The descent into `b` (through its parent's descriptor): swap it for a link to `outside` first.
    if (swapped || !/^\/proc\/self\/fd\/\d+\/b$/.test(path)) return;
    swapped = true;
    await fsp.rename(victim, join(base, 'moved'));
    await fsp.symlink(outside, victim);
  };
  await removeTree(top);
  expect(swapped).toBe(true);
  expect(existsSync(top)).toBe(false);
  expect(outsideIntact()).toBe(true);
});

it('a link or a file at the top is unlinked, its target untouched; a missing path is fine', async () => {
  await fsp.symlink(outside, join(base, 'link'));
  await removeTree(join(base, 'link'));
  expect(existsSync(join(base, 'link'))).toBe(false);
  expect(outsideIntact()).toBe(true);
  await fsp.writeFile(join(base, 'file'), 'x');
  await removeTree(join(base, 'file'));
  expect(existsSync(join(base, 'file'))).toBe(false);
  await expect(removeTree(join(base, 'missing'))).resolves.toBeUndefined();
});

it('leaves what lies past 256 levels in place rather than walk it by path, and never throws', async () => {
  const top = join(base, 'deep');
  let d = top;
  for (let i = 0; i < 260; i++) d = join(d, 'd');
  await fsp.mkdir(d, { recursive: true });
  await fsp.symlink(outside, join(d, 'link'));
  await expect(removeTree(top)).resolves.toBeUndefined();
  expect(existsSync(top)).toBe(true);
  expect(outsideIntact()).toBe(true);
});
