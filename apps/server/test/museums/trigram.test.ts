import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { similarity, trigrams } from '../../src/museums/trigram.ts';

describe('trigrams', () => {
  it('pads each word with two spaces in front and one behind', () => {
    expect([...trigrams('word')].sort()).toEqual(['  w', ' wo', 'ord', 'rd ', 'wor']);
  });

  it('a one-letter word gives two trigrams', () => {
    expect([...trigrams('a')].sort()).toEqual(['  a', ' a ']);
  });

  it('splits on non-alphanumerics, lower-cases and keeps a set', () => {
    expect(trigrams('Ab-ab, AB')).toEqual(trigrams('ab'));
    expect(trigrams('')).toEqual(new Set());
    expect(trigrams(' !! ')).toEqual(new Set());
  });
});

describe('similarity (known values; the PostgreSQL equality is in trigram.int.test.ts)', () => {
  it('identical is 1, disjoint is 0', () => {
    expect(similarity('rijks', 'rijks')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('empty on either side is 0, even both', () => {
    expect(similarity('', '')).toBe(0);
    expect(similarity('', 'abc')).toBe(0);
    expect(similarity('abc', '')).toBe(0);
    expect(similarity('!!!', '???')).toBe(0);
  });

  it('shared over union, as a float4', () => {
    // pg_trgm documents similarity('word', 'two words') = 0.363636
    expect(similarity('word', 'two words')).toBe(Math.fround(4 / 11));
    // abc: {"  a"," ab",abc,"bc "}, abd: {"  a"," ab",abd,"bd "}: 2 shared, 6 in the union
    expect(similarity('abc', 'abd')).toBe(Math.fround(2 / 6));
    // a: {"  a"," a "}, ab: {"  a"," ab","ab "}: 1 shared, 4 in the union
    expect(similarity('a', 'ab')).toBe(0.25);
  });

  it('repeated words add no trigrams', () => {
    expect(similarity('museum museum', 'museum')).toBe(1);
  });

  it('is symmetric, within [0, 1], and 1 against itself unless empty', () => {
    const s = fc.stringMatching(/^[a-z0-9 ]{0,30}$/);
    fc.assert(
      fc.property(s, s, (a, b) => {
        const x = similarity(a, b);
        expect(x).toBe(similarity(b, a));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        if (trigrams(a).size > 0) expect(similarity(a, a)).toBe(1);
      }),
      { numRuns: 300 },
    );
  });
});
