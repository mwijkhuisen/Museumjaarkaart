import { z } from 'zod';
import { DisplayName, Handle } from './auth.ts';
import { BAD_TEXT_CHAR, Cursor, codePoints, IsoDate, IsoDateTime, isStorable, Slug } from './common.ts';
import { OwnPhoto, PHOTOS_PER_REVIEW, PublicPhoto } from './media.ts';
import { Limit } from './queries.ts';

// Ratings and reviews (A§8 `review`, D13, ADR-0017, P3a): the request and answer schemas.

/** The six optional aspect ratings of a review (owner, P3a Q1), in display order; each is 1–5 or null. */
export const ASPECTS = [
  'collection',
  'presentation',
  'kid_friendly',
  'accessibility',
  'facilities',
  'value_for_money',
] as const;
export type Aspect = (typeof ASPECTS)[number];

// ---- Text rule (the database CHECK on review.body is the same class; WP3 tests that they agree) ----------

export const REVIEW_BODY_MAX = 5000;
const BODY_UTF16_MAX = 4 * REVIEW_BODY_MAX;

/** CRLF, CR, U+2028 and U+2029 become LF, TAB a space, then trim; empty is null. */
export function normaliseReviewBody(s: string): string | null {
  const t = s
    .replace(/\r\n|\r|\u{2028}|\u{2029}/gu, '\n')
    .replaceAll('\t', ' ')
    .trim();
  return t === '' ? null : t;
}

/** The one rule for a normalised body: storable, no forbidden character, 1 to 5,000 code points. */
export function isReviewText(s: string): boolean {
  const n = codePoints(s);
  return isStorable(s) && n >= 1 && n <= REVIEW_BODY_MAX && !BAD_TEXT_CHAR.test(s.replaceAll('\n', ''));
}

// ---- Requests ----------------------------------------------------------------------------------------

export const Rating = z.int().min(1).max(5);
/** An average: 1 to 5 with at most one decimal. */
export const Mean = z
  .number()
  .min(1)
  .max(5)
  .refine((n) => Math.round(n * 10) / 10 === n, { message: 'one decimal' });
export const AspectStat = z.strictObject({ mean: Mean.nullable(), count: z.int().min(0) });

export const ReviewBody = z
  .string()
  .max(BODY_UTF16_MAX)
  .nullable()
  .transform((s, ctx) => {
    const t = s === null ? null : normaliseReviewBody(s);
    if (t !== null && !isReviewText(t)) ctx.issues.push({ code: 'custom', message: 'not review text', input: s });
    return t;
  });

const AspectRatings = Object.fromEntries(ASPECTS.map((a) => [a, Rating.nullable().optional()])) as Record<
  Aspect,
  z.ZodOptional<z.ZodNullable<typeof Rating>>
>;

export const ReviewCreate = z.strictObject({
  museum_id: z.uuid(),
  visit_id: z.uuid(),
  rating: Rating,
  ...AspectRatings,
  body: ReviewBody.optional(),
  /** Photos of this member and museum to attach (P3b): unique, at most 10. */
  media_ids: z
    .array(z.uuid())
    .max(PHOTOS_PER_REVIEW)
    .refine((a) => new Set(a).size === a.length, { message: 'duplicate' })
    .optional(),
});
export type ReviewCreate = z.output<typeof ReviewCreate>;

export const ReviewPatch = z
  .strictObject({
    visit_id: z.uuid().optional(),
    rating: Rating.optional(),
    ...AspectRatings,
    body: ReviewBody.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });
export type ReviewPatch = z.output<typeof ReviewPatch>;

export const ReviewIdParam = z.uuid();
export const ReviewListQuery = z.strictObject({ limit: Limit, cursor: Cursor.optional() });
export type ReviewListQuery = z.infer<typeof ReviewListQuery>;

// ---- Answers -----------------------------------------------------------------------------------------

const AspectOut = Object.fromEntries(ASPECTS.map((a) => [a, Rating.nullable()])) as Record<
  Aspect,
  z.ZodNullable<typeof Rating>
>;

export const OwnReview = z.strictObject({
  id: z.uuid(),
  museum_id: z.uuid(),
  visit_id: z.uuid(),
  visited_on: IsoDate.nullable(),
  rating: Rating,
  ...AspectOut,
  body: z.string().max(BODY_UTF16_MAX).nullable(),
  created_at: IsoDateTime,
  edited_at: IsoDateTime.nullable(),
  photos: z.array(OwnPhoto).max(PHOTOS_PER_REVIEW),
});
export type OwnReview = z.infer<typeof OwnReview>;

export const PublicReview = z.strictObject({
  id: z.uuid(),
  museum: z.strictObject({
    id: z.uuid(),
    slug: Slug,
    name: z.string().min(1).max(250),
    name_en: z.string().max(250).nullable(),
  }),
  author: z.strictObject({
    handle: Handle.nullable(),
    display_name: DisplayName.nullable(),
    active: z.boolean(),
    former_member: z.boolean(),
  }),
  visited_on: IsoDate.nullable(),
  rating: Rating,
  ...AspectOut,
  body: z.string().max(BODY_UTF16_MAX).nullable(),
  created_at: IsoDateTime,
  edited_at: IsoDateTime.nullable(),
  photos: z.array(PublicPhoto).max(PHOTOS_PER_REVIEW),
});
export type PublicReview = z.infer<typeof PublicReview>;

export const ReviewList = z.strictObject({ items: z.array(PublicReview).max(50), next_cursor: Cursor.nullable() });
export type ReviewList = z.infer<typeof ReviewList>;
