import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  codePoints,
  isReviewText,
  normaliseReviewBody,
  REVIEW_BODY_MAX,
  ReviewBody,
  ReviewCreate,
  ReviewPatch,
} from '../src/index.ts';

const U = (n: number) => String.fromCodePoint(n);
const ids = { museum_id: '0194f2c0-0000-7000-8000-000000000001', visit_id: '0194f2c0-0000-7000-8000-000000000002' };

/** The body as the request schema sees it: normalised, then judged. */
const ok = (s: string) => ReviewBody.safeParse(s).success;

describe('code points', () => {
  it('counts an emoji and a ZWJ sequence per code point', () => {
    expect(codePoints('\u{1F3A8}')).toBe(1);
    expect(codePoints('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe(5);
  });

  it('allows 5,000 code points and refuses 5,001', () => {
    expect(isReviewText('\u{1F3A8}'.repeat(REVIEW_BODY_MAX))).toBe(true);
    expect(isReviewText('\u{1F3A8}'.repeat(REVIEW_BODY_MAX + 1))).toBe(false);
    expect(isReviewText('a'.repeat(REVIEW_BODY_MAX))).toBe(true);
    expect(isReviewText('a'.repeat(REVIEW_BODY_MAX + 1))).toBe(false);
  });
});

describe('the body rule', () => {
  const bad = [
    '\ud800',
    '\udc00',
    U(0),
    ...Array.from({ length: 8 }, (_, i) => U(i + 1)),
    U(0xb),
    U(0xc),
    ...Array.from({ length: 18 }, (_, i) => U(0xe + i)),
    ...Array.from({ length: 33 }, (_, i) => U(0x7f + i)),
    ...Array.from({ length: 5 }, (_, i) => U(0x202a + i)),
    ...Array.from({ length: 4 }, (_, i) => U(0x2066 + i)),
  ];
  it.each(bad.map((c) => [c.codePointAt(0)?.toString(16) ?? '', c]))('refuses U+%s', (_h, c) => {
    expect(ok(`a${c}b`)).toBe(false);
  });

  it('accepts newlines, TAB, NBSP and punctuation after normalising', () => {
    for (const s of ['a\nb', 'a\r\nb', 'a\rb', 'a\tb', `a${U(0xa0)}b`, 'Mooi! "Echt" (4/5) - tot ziens, ja?']) {
      expect(ok(s), JSON.stringify(s)).toBe(true);
    }
    for (const c of [U(0x2028), U(0x2029)]) expect(ReviewBody.parse(`a${c}b`)).toBe('a\nb');
    expect(ReviewBody.parse('a\r\nb\tc')).toBe('a\nb c');
  });

  it('turns whitespace-only and null into null, and reports a bad body at path body', () => {
    expect(ReviewBody.parse('  \n\t ')).toBeNull();
    expect(ReviewBody.parse(null)).toBeNull();
    const r = ReviewCreate.safeParse({ ...ids, rating: 4, body: `a${U(1)}` });
    expect(r.success ? [] : r.error.issues.map((i) => i.path[0])).toEqual(['body']);
  });

  it('never throws, and returns null or trimmed text without CR, TAB, U+2028 or U+2029', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const t = normaliseReviewBody(s);
        return t === null || (t === t.trim() && t !== '' && !/[\r\t\u{2028}\u{2029}]/u.test(t));
      }),
    );
  });
});

describe('ReviewCreate and ReviewPatch', () => {
  it('parse a minimal create and default the body to undefined', () => {
    expect(ReviewCreate.parse({ ...ids, rating: 5 })).toEqual({ ...ids, rating: 5 });
    expect(ReviewCreate.parse({ ...ids, rating: 5, kid_friendly: null, body: ' hi ' })).toEqual({
      ...ids,
      rating: 5,
      kid_friendly: null,
      body: 'hi',
    });
  });

  it('refuse unknown keys and ratings outside 1 to 5 whole numbers', () => {
    expect(ReviewCreate.safeParse({ ...ids, rating: 4, extra: 1 }).success).toBe(false);
    expect(ReviewPatch.safeParse({ rating: 4, extra: 1 }).success).toBe(false);
    expect(ReviewPatch.safeParse({ museum_id: ids.museum_id, rating: 4 }).success).toBe(false);
    for (const rating of [0, 6, 1.5, '4']) {
      expect(ReviewCreate.safeParse({ ...ids, rating }).success, String(rating)).toBe(false);
      expect(ReviewPatch.safeParse({ rating }).success, String(rating)).toBe(false);
      expect(ReviewCreate.safeParse({ ...ids, rating: 3, facilities: rating }).success, String(rating)).toBe(false);
    }
  });

  it('needs at least one key in a patch', () => {
    expect(ReviewPatch.safeParse({}).success).toBe(false);
    expect(ReviewPatch.safeParse({ body: null }).success).toBe(true);
  });
});
