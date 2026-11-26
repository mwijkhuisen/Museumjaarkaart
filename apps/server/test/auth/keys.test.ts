import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APP_KEY_NAMES, parseAppKeys, readAppKeys } from '../../src/auth/keys.ts';
import { writeTestKeys } from './test-keys.ts';

const v = (bytes = 32) => randomBytes(bytes).toString('base64url');
const lines = (values: Record<string, string>) => Object.entries(values).map(([k, x]) => `${k}=${x}`);
const valid = () => Object.fromEntries(APP_KEY_NAMES.map((n) => [n, v()]));

describe('parseAppKeys', () => {
  it('reads a valid file', () => {
    const values = valid();
    const keys = parseAppKeys(`${lines(values).join('\n')}\n`);
    expect(typeof keys).toBe('object');
    for (const n of APP_KEY_NAMES)
      expect((keys as Record<string, Buffer>)[n]).toEqual(Buffer.from(values[n] as string, 'base64url'));
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it('accepts \\r\\n line ends, empty lines and no final newline', () => {
    expect(typeof parseAppKeys(`\r\n${lines(valid()).join('\r\n\r\n')}`)).toBe('object');
  });

  it('ignores a well-formed unknown name', () => {
    const keys = parseAppKeys([...lines(valid()), `export_link=${v()}`].join('\n'));
    expect(typeof keys).toBe('object');
    expect(Object.keys(keys as object).sort()).toEqual([...APP_KEY_NAMES].sort());
  });

  it('refuses a missing name and a duplicate', () => {
    const { otp_pepper: _, ...rest } = valid();
    expect(parseAppKeys(lines(rest).join('\n'))).toBe('app_keys: otp_pepper missing');
    expect(parseAppKeys([...lines(valid()), `code_seal=${v()}`].join('\n'))).toBe('app_keys: code_seal duplicated');
  });

  it.each([
    ['42 characters', v(31)],
    ['44 characters', `${v()}A`],
    ['31 bytes, padded to 43', `${v(31)}=`],
    ['a padded value', `${v()}=`],
    ['spare low bits set', `${v().slice(0, 42)}B`],
    ['standard base64', `+${v().slice(1)}`],
  ])('refuses a value of %s', (_, value) => {
    expect(parseAppKeys([...lines(valid()), `export_link=${value}`].join('\n'))).toBe('app_keys: line 5 malformed');
  });

  it.each([
    ['a bad name', `Otp-pepper=${v()}`],
    ['a 41-character name', `${'a'.repeat(41)}=${v()}`],
    ['no =', `otp_pepper${v()}`],
    ['a space', `otp_pepper = ${v()}`],
    ['a comment', '# keys'],
  ])('refuses %s', (_, line) => {
    expect(parseAppKeys([line, ...lines(valid())].join('\n'))).toBe('app_keys: line 1 malformed');
  });

  it('refuses a file over 64 KiB', () => {
    expect(parseAppKeys(`${lines(valid()).join('\n')}${'\n'.repeat(65536)}`)).toBe('app_keys: over 64 KiB');
  });

  it('never throws, and an error names no value of the file', () => {
    const line = fc.oneof(
      fc.string(),
      fc.constantFrom(...APP_KEY_NAMES).map((n) => `${n}=${v()}`),
      fc.string({ unit: fc.constantFrom(...'abc_-=AZ09\r\n'), maxLength: 60 }),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), fc.constantFrom('\n', '\r\n'), (ls, eol) => {
        const text = ls.join(eol);
        const out = parseAppKeys(text);
        if (typeof out === 'string') {
          // Names have at most 40 characters and the rest of an error is fixed text.
          for (const m of text.matchAll(/=([^\r\n]{41,})/g)) expect(out).not.toContain(m[1]);
        } else {
          expect(Object.keys(out).sort()).toEqual([...APP_KEY_NAMES].sort());
        }
      }),
    );
  });
});

describe('readAppKeys', () => {
  it('reads <dir>/app_keys', () => {
    const { dir, keys } = writeTestKeys();
    expect(readAppKeys(dir)).toEqual(keys);
  });

  it('refuses a missing file and an over-large file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mjk-keys-'));
    expect(readAppKeys(dir)).toBe('app_keys: unreadable');
    writeFileSync(join(dir, 'app_keys'), Buffer.alloc(65537, 10));
    expect(readAppKeys(dir)).toBe('app_keys: over 64 KiB');
  });
});
