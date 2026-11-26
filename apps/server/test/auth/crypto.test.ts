import { createHmac, randomBytes } from 'node:crypto';
import { INVITE_CODE_RE, normaliseInviteCode } from '@mjk/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  hmac,
  newInviteCode,
  newSessionToken,
  open,
  safeEqual,
  seal,
  sessionTokenHash,
  sha256,
  sixDigitCode,
} from '../../src/auth/crypto.ts';

const key = randomBytes(32);

describe('seal and open', () => {
  const flip = (sealed: string, part: 1 | 2, at: number) => {
    const parts = sealed.split('.');
    const bytes = Buffer.from(parts[part] as string, 'base64url');
    const i = at < 0 ? bytes.length + at : at;
    bytes[i] = (bytes[i] as number) ^ 1;
    parts[part] = bytes.toString('base64url');
    return parts.join('.');
  };

  it('round-trips, with a fresh nonce per seal', () => {
    const a = seal(key, '123456 · é', 'mail_code:42');
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(open(key, a, 'mail_code:42')).toBe('123456 · é');
    expect(seal(key, '123456 · é', 'mail_code:42')).not.toBe(a);
    expect(open(key, seal(key, '', ''), '')).toBe('');
  });

  it('opens nothing that was changed', () => {
    const s = seal(key, 'secret', 'aad');
    expect(open(key, flip(s, 1, 0), 'aad')).toBeNull(); // nonce
    expect(open(key, flip(s, 2, 0), 'aad')).toBeNull(); // ciphertext
    expect(open(key, flip(s, 2, -1), 'aad')).toBeNull(); // tag
    expect(open(key, s, 'aae')).toBeNull();
    expect(open(randomBytes(32), s, 'aad')).toBeNull();
    expect(open(randomBytes(16), s, 'aad')).toBeNull();
    expect(open(key, `v2${s.slice(2)}`, 'aad')).toBeNull();
    expect(open(key, s.slice(0, -1), 'aad')).toBeNull();
    expect(open(key, s.slice(0, 30), 'aad')).toBeNull();
    expect(open(key, `${s}.x`, 'aad')).toBeNull();
    expect(open(key, s.replace(/\.(.)/, '.+'), 'aad')).toBeNull();
    expect(open(key, `${s}=`, 'aad')).toBeNull();
  });

  it('never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (s, aad) => open(key, s, aad) === null));
  });
});

describe('hmac', () => {
  it('separates the parts', () => {
    expect(hmac(key, 'ab', 'c')).not.toEqual(hmac(key, 'a', 'bc'));
    expect(hmac(key, 'abc')).not.toEqual(hmac(key, 'ab', 'c'));
    expect(hmac(key, 'é')).toEqual(hmac(key, Buffer.from('é', 'utf8')));
  });

  it('prefixes each part with its byte length, 4 bytes big-endian', () => {
    const expected = createHmac('sha256', key)
      .update(Buffer.from([0, 0, 0, 2]))
      .update('é')
      .update(Buffer.from([0, 0, 0, 0]))
      .digest();
    expect(hmac(key, 'é', '')).toEqual(expected);
    expect(hmac(key)).toHaveLength(32);
  });
});

describe('safeEqual and sha256', () => {
  it('compares', () => {
    expect(safeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
    expect(sha256('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('codes', () => {
  it('sixDigitCode is six digits', () => {
    fc.assert(fc.property(fc.nat(), () => /^[0-9]{6}$/.test(sixDigitCode())));
  });

  it('newInviteCode matches INVITE_CODE_RE and survives typed normalisation', () => {
    fc.assert(
      fc.property(fc.nat(), () => {
        const code = newInviteCode();
        const typed = code.toLowerCase().replace(/(.{4})(?!$)/g, '$1-');
        return INVITE_CODE_RE.test(code) && normaliseInviteCode(typed) === code;
      }),
    );
  });
});

describe('session tokens', () => {
  it('are 43 characters, and the hash is sha256 of the 32 decoded bytes', () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionTokenHash(t)).toEqual(sha256(Buffer.from(t, 'base64url')));
    expect(sessionTokenHash(t)).toEqual(sessionTokenHash(t));
    expect(newSessionToken()).not.toBe(t);
  });

  it('refuses anything else', () => {
    const t = newSessionToken();
    for (const bad of [t.slice(1), `${t}=`, `${t.slice(0, 42)}=`, `+${t.slice(1)}`, `/${t.slice(1)}`, `${t}A`, '']) {
      expect(sessionTokenHash(bad)).toBeNull();
    }
    // The same 32 bytes with the spare low bits set: one token, one spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const spare = `${t.slice(0, 42)}${alphabet[alphabet.indexOf(t[42] as string) + 1]}`;
    expect(Buffer.from(spare, 'base64url')).toEqual(Buffer.from(t, 'base64url'));
    expect(sessionTokenHash(spare)).toBeNull();
  });
});
