import { HANDLE_RE, RESERVED_HANDLES } from '@mjk/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// P2c criterion 9, the pure half: a handle is 3 to 30 characters of [a-z0-9_] and nothing else.
// The sign-up and database halves are in handle.int.test.ts.

const CHARS = [...'abcdefghijklmnopqrstuvwxyz0123456789_'];
const good = (min: number, max: number) =>
  fc.string({ unit: fc.constantFrom(...CHARS), minLength: min, maxLength: max });

describe('HANDLE_RE', () => {
  it('takes every 3 to 30 character string of [a-z0-9_]', () => {
    fc.assert(fc.property(good(3, 30), (h) => HANDLE_RE.test(h)));
  });

  it('refuses a string that is too short or too long', () => {
    fc.assert(fc.property(good(0, 2), (h) => !HANDLE_RE.test(h)));
    fc.assert(fc.property(good(31, 64), (h) => !HANDLE_RE.test(h)));
  });

  it('refuses a valid handle with any other character in it, anywhere (upper case, accents, dashes, newlines)', () => {
    const other = fc
      .string({ unit: 'grapheme-composite', minLength: 1, maxLength: 3 })
      .filter((s) => [...s].some((ch) => !CHARS.includes(ch)));
    fc.assert(
      fc.property(good(2, 20), other, fc.nat(), (h, x, at) => {
        const i = at % (h.length + 1);
        return !HANDLE_RE.test(h.slice(0, i) + x + h.slice(i));
      }),
    );
    for (const h of ['Abc', 'abC', 'a-b', 'a b', 'abc\n', '\nabc', 'ábc', 'ａｂｃ', 'abc\u{0}'])
      expect(HANDLE_RE.test(h), JSON.stringify(h)).toBe(false);
  });

  it('the reserved list is lower case, so a reserved word cannot be dodged by case', () => {
    for (const r of RESERVED_HANDLES) expect(r, r).toBe(r.toLowerCase());
  });
});
