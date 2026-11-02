import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanText, codePointLength, hasInvisible, postcode } from '../../../src/museums/sources/text.ts';
import { CH, FORBIDDEN_CHARS } from './golden.ts';

const value = (s: string, max = 250) => {
  const r = cleanText(s, max);
  return r.ok ? r.value : r.code;
};

describe('cleanText', () => {
  it('collapses whitespace, CR and LF included, and trims', () => {
    expect(value('  Museum \r\n\t De   Waag \n')).toBe('Museum De Waag');
    expect(value(`a${CH.nbsp}b${CH.ls}c${CH.nel}d`)).toBe('a b c d');
  });

  it('normalises to NFC', () => {
    expect(value(`Cafe${CH.acute}`)).toBe(`Caf${String.fromCodePoint(0xe9)}`);
    expect(value(`Cafe${CH.zwj}${CH.acute}`)).toBe(`Caf${String.fromCodePoint(0xe9)}`);
  });

  it('strips C0 and C1 controls, bidi controls and zero-width characters', () => {
    expect(value(`Mu${CH.zwj}se${CH.zwsp}um${CH.bom}${CH.wj}${CH.shy}`)).toBe('Museum');
    expect(value(`${CH.rlo}gnitset${CH.pdf} ${CH.lro}LRO${CH.pdf} ${CH.lri}iso${CH.pdi} ${CH.lrm}${CH.rlm}`)).toBe(
      'gnitset LRO iso',
    );
    expect(value(`Mu${CH.zwj}se${CH.zwsp}um${CH.bom}${CH.wj}${CH.shy}`)).toBe('Museum');
    expect(value('a\u009Fb\u007Fc')).toBe('abc');
  });

  it('removes lone surrogates', () => {
    expect(value('a\uD800b')).toBe(`a${String.fromCodePoint(0xfffd)}b`);
    expect(hasInvisible('a\uD800b')).toBe(true);
  });

  it('keeps emoji and non-Latin scripts', () => {
    const wide = `Museum ${String.fromCodePoint(0x1f3a8)} ${String.fromCodePoint(0x535a, 0x7269, 0x9928)}`;
    expect(value(wide)).toBe(wide);
  });

  it('returns empty for a value with nothing left', () => {
    expect(value('')).toBe('empty');
    expect(value(' \r\n\t ')).toBe('empty');
    expect(value(`${CH.zwsp}${CH.rlo}${CH.nul}`)).toBe('empty');
  });

  it('counts code points against the cap', () => {
    expect(value('a'.repeat(250))).toBe('a'.repeat(250));
    expect(value('a'.repeat(251))).toBe('too_long');
    expect(value('\u{1F3A8}'.repeat(250))).toBe('\u{1F3A8}'.repeat(250));
    expect(value('\u{1F3A8}'.repeat(251))).toBe('too_long');
    expect(value('a'.repeat(5001))).toBe('too_long');
    // Characters that are removed do not count.
    expect(value(`${'a'.repeat(250)}${CH.zwsp}${CH.zwsp}`)).toBe('a'.repeat(250));
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = cleanText(s, 5000);
        if (once.ok) expect(cleanText(once.value, 5000)).toEqual(once);
      }),
    );
  });

  it('never returns a control or bidi character, and never more than the cap', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), fc.integer({ min: 1, max: 300 }), (s, max) => {
        const r = cleanText(s, max);
        if (!r.ok) return;
        expect(FORBIDDEN_CHARS.test(r.value)).toBe(false);
        expect(codePointLength(r.value)).toBeLessThanOrEqual(max);
        expect(r.value).toBe(r.value.normalize('NFC'));
        expect(r.value).toBe(r.value.trim());
        expect(/\s{2}|[^\S ]/u.test(r.value)).toBe(false);
        expect(r.value.isWellFormed()).toBe(true);
      }),
    );
  });

  it('survives text that is made of the characters it removes', () => {
    const nasty = fc.constantFrom(
      CH.nul,
      '\u001F',
      CH.nel,
      CH.zwsp,
      CH.zwj,
      CH.rlo,
      CH.lri,
      CH.bom,
      '\r',
      '\n',
      ' ',
      'a',
      CH.acute,
    );
    fc.assert(
      fc.property(fc.array(nasty, { maxLength: 60 }), (parts) => {
        const r = cleanText(parts.join(''), 30);
        if (r.ok) expect(FORBIDDEN_CHARS.test(r.value)).toBe(false);
      }),
    );
  });
});

describe('postcode', () => {
  it('normalises to 1234 AB', () => {
    expect(postcode('1071 DJ')).toBe('1071 DJ');
    expect(postcode('1071DJ')).toBe('1071 DJ');
    expect(postcode('1071dj')).toBe('1071 DJ');
    expect(postcode('  1071   dJ ')).toBe('1071 DJ');
    expect(postcode(`1071${CH.nbsp}DJ`)).toBe('1071 DJ');
  });

  it.each(['', '0123 AB', '123 AB', '12345 AB', '1071 D', '1071 DJX', '1071-DJ', '1071 D1', 'NL-1071 DJ', '1071 ΔJ'])(
    'rejects %j',
    (s) => {
      expect(postcode(s)).toBeUndefined();
    },
  );

  it('only ever returns the stored shape', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => {
        const p = postcode(s);
        if (p !== undefined) expect(p).toMatch(/^[1-9][0-9]{3} [A-Z]{2}$/);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 9999 }), fc.stringMatching(/^[a-zA-Z]{2}$/), (n, l) => {
        expect(postcode(`${n}${l}`)).toBe(`${n} ${l.toUpperCase()}`);
      }),
    );
  });
});
