import { describe, expect, it } from 'vitest';
import {
  ALT_TEXT_MAX,
  isAltText,
  isReviewText,
  MediaAltPatch,
  OwnPhoto,
  PhotoList,
  PreviewQuery,
  PublicPhoto,
  PublicReview,
  ReviewCreate,
} from '../src/index.ts';

// P3b WP5: the photo shapes on reviews, the alt text rule and `media_ids`.

const U = (n: number) => String.fromCodePoint(n);
const id = (n: number) => `0194f2c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ids = { museum_id: id(1), visit_id: id(2), rating: 4 };
const photo = {
  id: id(9),
  width: 1600,
  height: 1200,
  alt_text: null,
  public_key: 'ab'.repeat(16),
  widths: [400, 1200],
};

describe('the alt text rule', () => {
  it('agrees with the review text rule on every character class, and adds the one-line and 250 limits', () => {
    for (const bad of [U(7), U(0x7f), U(0x85), U(0x2028), U(0x2029), U(0x202e), U(0x2066), U(0)])
      expect(isAltText(`a${bad}b`), `U+${bad.codePointAt(0)?.toString(16)}`).toBe(false);
    for (const bad of [U(7), U(0x7f), U(0x2028), U(0x202e), U(0x2066), U(0)])
      expect(isReviewText(`a${bad}b`)).toBe(false);
    expect(isAltText('een\nregel')).toBe(false);
    expect(isReviewText('een\nregel')).toBe(true);
    expect(isAltText('a'.repeat(ALT_TEXT_MAX))).toBe(true);
    expect(isAltText('a'.repeat(ALT_TEXT_MAX + 1))).toBe(false);
    expect(isAltText('\u{1F3A8}'.repeat(ALT_TEXT_MAX))).toBe(true);
    expect(isAltText('')).toBe(false);
  });

  it('is trimmed by the patch schema, and null clears', () => {
    expect(MediaAltPatch.parse({ alt_text: '  zaal  ' })).toEqual({ alt_text: 'zaal' });
    expect(MediaAltPatch.parse({ alt_text: null })).toEqual({ alt_text: null });
    expect(MediaAltPatch.safeParse({ alt_text: '   ' }).success).toBe(false);
    expect(MediaAltPatch.safeParse({ alt_text: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('ReviewCreate.media_ids', () => {
  it('takes up to ten unique uuids', () => {
    expect(ReviewCreate.safeParse(ids).success).toBe(true);
    const ten = Array.from({ length: 10 }, (_, i) => id(100 + i));
    expect(ReviewCreate.safeParse({ ...ids, media_ids: ten }).success).toBe(true);
    expect(ReviewCreate.safeParse({ ...ids, media_ids: [...ten, id(200)] }).success).toBe(false);
    expect(ReviewCreate.safeParse({ ...ids, media_ids: [id(5), id(5)] }).success).toBe(false);
    expect(ReviewCreate.safeParse({ ...ids, media_ids: ['x'] }).success).toBe(false);
  });
});

describe('the photo answers are strict', () => {
  it('refuse an extra field, so a state, hash or user id can never ride along', () => {
    expect(PublicPhoto.safeParse(photo).success).toBe(true);
    for (const extra of ['state', 'sha256', 'user_id', 'error_code'])
      expect(PublicPhoto.safeParse({ ...photo, [extra]: 'x' }).success, extra).toBe(false);
    expect(PublicPhoto.safeParse({ ...photo, public_key: 'XYZ' }).success).toBe(false);
    expect(PublicPhoto.safeParse({ ...photo, alt_text: '' }).success).toBe(false);
    const own = {
      id: id(9),
      state: 'pending_review',
      width: null,
      height: null,
      alt_text: null,
      public_key: null,
      widths: [],
    };
    expect(OwnPhoto.safeParse(own).success).toBe(true);
    expect(OwnPhoto.safeParse({ ...own, state: 'nonsense' }).success).toBe(false);
    expect(OwnPhoto.safeParse({ ...own, sha256: 'x' }).success).toBe(false);
  });

  it('PublicReview needs its photos and PhotoList its next_cursor', () => {
    expect(PhotoList.safeParse({ items: [], next_cursor: null }).success).toBe(true);
    expect(PhotoList.safeParse({ items: [] }).success).toBe(false);
    expect(PublicReview.shape.photos.safeParse([photo]).success).toBe(true);
    expect(PublicReview.shape.photos.safeParse(undefined).success).toBe(false);
  });

  it('the preview width is 400 or 1200', () => {
    expect(PreviewQuery.parse({})).toEqual({ w: '400' });
    expect(PreviewQuery.parse({ w: '1200' })).toEqual({ w: '1200' });
    expect(PreviewQuery.safeParse({ w: '800' }).success).toBe(false);
  });
});
