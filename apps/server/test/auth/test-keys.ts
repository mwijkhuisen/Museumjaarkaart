import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_KEY_NAMES, type AppKeys } from '../../src/auth/keys.ts';

/** A fresh set of random app keys (tests only). */
export function makeTestKeys(): AppKeys {
  return Object.freeze(Object.fromEntries(APP_KEY_NAMES.map((name) => [name, randomBytes(32)])) as AppKeys);
}

/** Writes a valid `app_keys` file into `dir`, or into a fresh temporary directory. */
export function writeTestKeys(dir: string = mkdtempSync(join(tmpdir(), 'mjk-keys-'))): { dir: string; keys: AppKeys } {
  const keys = makeTestKeys();
  const text = APP_KEY_NAMES.map((name) => `${name}=${keys[name].toString('base64url')}\n`).join('');
  writeFileSync(join(dir, 'app_keys'), text, { mode: 0o600 });
  return { dir, keys };
}
