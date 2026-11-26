import { readFileSync } from 'node:fs';
import { SECRETS_DIR } from '../db/migrate.ts';

// The `app_keys` file secret (A§9, A§17.3): UTF-8 text, one `name=value` per line, each value
// 32 random bytes as base64url without padding. Empty lines and `\r\n` are allowed; no comments.
// A well-formed line with an unknown name is ignored, so a later phase's key can be deployed
// before or after its code. Errors name the problem and a key or line number, never a value
// (CLAUDE.md security invariants 1 and 8); the caller logs the string and exits 78.

export const APP_KEY_NAMES = ['otp_pepper', 'invite_pepper', 'code_seal', 'altcha_hmac'] as const;
export type AppKeyName = (typeof APP_KEY_NAMES)[number];
export type AppKeys = Readonly<Record<AppKeyName, Buffer>>;

const MAX_BYTES = 64 * 1024;
const LINE = /^([a-z0-9_]{1,40})=([A-Za-z0-9_-]{43})$/;

export function parseAppKeys(text: string): AppKeys | string {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return 'app_keys: over 64 KiB';
  const found = new Map<string, Buffer>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    const m = LINE.exec(line);
    const value = m ? Buffer.from(m[2] as string, 'base64url') : undefined;
    // 43 characters carry 258 bits: the round trip refuses a value whose spare low bits are set.
    if (!m || !value || value.length !== 32 || value.toString('base64url') !== m[2]) {
      return `app_keys: line ${i + 1} malformed`;
    }
    const name = m[1] as string;
    if (found.has(name)) return `app_keys: ${name} duplicated`;
    found.set(name, value);
  }
  const keys: Partial<Record<AppKeyName, Buffer>> = {};
  for (const name of APP_KEY_NAMES) {
    const value = found.get(name);
    if (!value) return `app_keys: ${name} missing`;
    keys[name] = value;
  }
  return Object.freeze(keys as Record<AppKeyName, Buffer>);
}

/** Reads and parses `<dir>/app_keys`; an error string (never a value) when it is missing or bad. */
export function readAppKeys(secretsDir = SECRETS_DIR): AppKeys | string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(`${secretsDir}/app_keys`);
  } catch {
    return 'app_keys: unreadable';
  }
  if (bytes.length > MAX_BYTES) return 'app_keys: over 64 KiB';
  return parseAppKeys(bytes.toString('utf8'));
}
