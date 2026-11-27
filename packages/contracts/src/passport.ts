import { z } from 'zod';
import { DISPLAY_NAME_MAX, Handle } from './auth.ts';
import { Cursor, IsoDate, IsoDateTime, LIMITS, ProvinceCodeSchema, Slug, StorableText } from './common.ts';
import { Limit, MuseumListQuery } from './queries.ts';
import { OwnReview, Rating, REVIEW_BODY_MAX } from './reviews.ts';

// The passport's contracts (P2c): visits, the wishlist, progress and € saved, imports, exports and
// public profiles. The numbers are Q6's, still [U] until P4 tunes them (A§10, A§14).

/** A visit's note, in characters. */
export const VISIT_NOTE_MAX = 2000;
/** Museums ticked in one `POST /me/visits/bulk`. */
export const BULK_MAX = 200;
/** Rows in one import file. */
export const IMPORT_ROWS_MAX = 5000;

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Year = z.number().int().min(1900).max(2200);
const Count = z.number().int().min(0);
const Name = z.string().max(LIMITS.label);
const Place = z.string().max(LIMITS.place).nullable();

// ---- Visits ---------------------------------------------------------------------------------

/** The database checks 1 to 2,000 characters; the client sends `null` for an empty note. */
export const VisitNote = StorableText.pipe(z.string().min(1).max(VISIT_NOTE_MAX));
export const VisitSource = z.enum(['manual', 'bulk', 'import']);

/** `slug` is null when the museum was hidden later: the member's own lists name it without a link. */
export const VisitMuseum = z.strictObject({
  id: z.uuid(),
  slug: Slug.nullable(),
  name: Name,
  name_en: Name.nullable(),
  place: Place,
});
export type VisitMuseum = z.infer<typeof VisitMuseum>;

export const Visit = z.strictObject({
  id: z.uuid(),
  museum: VisitMuseum,
  visited_on: IsoDate.nullable(),
  note: z.string().max(VISIT_NOTE_MAX).nullable(),
  source: VisitSource,
  created_at: IsoDateTime,
});
export type Visit = z.infer<typeof Visit>;

export const VisitCreate = z.strictObject({
  museum_id: z.uuid(),
  visited_on: IsoDate.nullable(),
  note: VisitNote.nullable().optional(),
});
export type VisitCreate = z.infer<typeof VisitCreate>;

export const VisitPatch = z
  .strictObject({ visited_on: IsoDate.nullable().optional(), note: VisitNote.nullable().optional() })
  .refine((v) => v.visited_on !== undefined || v.note !== undefined, { path: ['visited_on'] });
export type VisitPatch = z.infer<typeof VisitPatch>;

export const VisitListQuery = z.strictObject({ cursor: Cursor.optional(), limit: Limit });
export type VisitListQuery = z.infer<typeof VisitListQuery>;

export const VisitList = z.strictObject({ items: z.array(Visit).max(50), next: Cursor.nullable() });
export type VisitList = z.infer<typeof VisitList>;

export const BulkVisits = z.strictObject({ museum_ids: z.array(z.uuid()).min(1).max(BULK_MAX) });
export type BulkVisits = z.infer<typeof BulkVisits>;

export const BulkResult = z.strictObject({ added: Count, skipped: Count });
export type BulkResult = z.infer<typeof BulkResult>;

// ---- Wishlist and marks ---------------------------------------------------------------------

export const WishlistItem = z.strictObject({ museum: VisitMuseum, created_at: IsoDateTime });
export type WishlistItem = z.infer<typeof WishlistItem>;

/** One per museum, so bounded by the catalogue: no paging. */
export const Wishlist = z.strictObject({ items: z.array(WishlistItem).max(5000) });
export type Wishlist = z.infer<typeof Wishlist>;

/** GET /me/marks: null when signed out, like `Me`. */
export const Marks = z.strictObject({
  marks: z
    .strictObject({
      visited: z.array(z.uuid()).max(5000),
      wishlist: z.array(z.uuid()).max(5000),
      hide_ratings_until_visited: z.boolean(),
    })
    .nullable(),
});
export type Marks = z.infer<typeof Marks>;

/** GET /me/museums: the catalogue list (answer `MuseumList`) narrowed to the member's marks. */
const YesNo = z.enum(['yes', 'no']);
export const MemberMuseumsQuery = MuseumListQuery.extend({ visited: YesNo.optional(), wishlist: YesNo.optional() });
export type MemberMuseumsQuery = z.infer<typeof MemberMuseumsQuery>;

/** GET /me/museums/:slug. */
export const MemberMuseum = z.strictObject({
  visits: z.array(Visit).max(5000),
  wishlist: z.boolean(),
  review: OwnReview.nullable(),
});
export type MemberMuseum = z.infer<typeof MemberMuseum>;

// ---- Progress and € saved -------------------------------------------------------------------

/** One shape for GET /me/progress and the public profile. `list` is null before any list is published. */
export const Progress = z.strictObject({
  list: z
    .strictObject({
      published_on: IsoDate,
      n: Count,
      visited: Count,
      provinces: z.array(z.strictObject({ code: ProvinceCodeSchema.nullable(), n: Count, visited: Count })).max(13),
    })
    .nullable(),
  all_time: Count,
  years: z.array(z.strictObject({ year: Year, museums: Count })).max(200),
});
export type Progress = z.infer<typeof Progress>;

/** `stale`: a price exists but was verified over 18 months ago, so it counts as none (Q8). */
export const SavingsYear = z.strictObject({
  year: Year,
  card_type: z.enum(['adult', 'under_19']),
  saved_cents: Count,
  counted: Count,
  card_price_cents: Count.nullable(),
  net_cents: z.number().int().nullable(),
  reason: z.literal('no_card_price').nullable(),
  unpriced: z.array(z.strictObject({ museum: VisitMuseum, stale: z.boolean() })).max(5000),
});
export type SavingsYear = z.infer<typeof SavingsYear>;

export const MeProgress = z.strictObject({ progress: Progress, savings: z.array(SavingsYear).max(200) });
export type MeProgress = z.infer<typeof MeProgress>;

// ---- Imports --------------------------------------------------------------------------------

export const ImportFormat = z.enum(['csv', 'mjk', 'museotrack', 'cultra']);
export type ImportFormat = z.infer<typeof ImportFormat>;

/** The body cap of 2 MiB bounds it; the `.max` is a second fence. */
export const ImportRequest = z.strictObject({
  format: ImportFormat,
  content: StorableText.pipe(z.string().max(2 * 1024 * 1024)),
});
export type ImportRequest = z.infer<typeof ImportRequest>;

export const ImportRowError = z.enum([
  'bad_date',
  'future_date',
  'no_museum',
  'too_long',
  'bad_text',
  'bad_rating',
  'review_exists',
  'museum_closed',
]);
export type ImportRowError = z.infer<typeof ImportRowError>;

export const ImportRow = z.strictObject({
  row: z.number().int().min(1),
  kind: z.enum(['visit', 'wishlist']),
  name: z.string().max(250).nullable(),
  place: z.string().max(250).nullable(),
  visited_on: IsoDate.nullable(),
  note: z.string().max(VISIT_NOTE_MAX).nullable(),
  rating: Rating.nullable(),
  review: z
    .string()
    .max(4 * REVIEW_BODY_MAX)
    .nullable(),
  status: z.enum(['matched', 'ambiguous', 'unmatched', 'invalid']),
  error: ImportRowError.nullable(),
  museum: VisitMuseum.nullable(),
  candidates: z.array(VisitMuseum).max(5),
});
export type ImportRow = z.infer<typeof ImportRow>;

export const ImportPreview = z.strictObject({
  id: z.uuid(),
  format: ImportFormat,
  rows: z.array(ImportRow).max(IMPORT_ROWS_MAX),
  counts: z.strictObject({ matched: Count, ambiguous: Count, unmatched: Count, invalid: Count }),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportConfirm = z.strictObject({
  choose: z.array(z.strictObject({ row: z.number().int().min(1), museum_id: z.uuid() })).max(IMPORT_ROWS_MAX),
  skip: z.array(z.number().int().min(1)).max(IMPORT_ROWS_MAX),
});
export type ImportConfirm = z.infer<typeof ImportConfirm>;

export const ImportResult = z.strictObject({ visits: Count, wishlist: Count, reviews: Count, skipped: Count });
export type ImportResult = z.infer<typeof ImportResult>;

// ---- Exports --------------------------------------------------------------------------------

export const ExportFile = z.enum(['export.json', 'visits.csv', 'wishlist.csv']);
export type ExportFile = z.infer<typeof ExportFile>;

/** `files` is empty unless the export is ready and unexpired. */
export const ExportItem = z.strictObject({
  id: z.uuid(),
  state: z.enum(['queued', 'ready', 'failed']),
  created_at: IsoDateTime,
  expires_at: IsoDateTime.nullable(),
  files: z.array(ExportFile).max(3),
});
export type ExportItem = z.infer<typeof ExportItem>;

export const ExportList = z.strictObject({ items: z.array(ExportItem).max(50) });
export type ExportList = z.infer<typeof ExportList>;

// ---- Public profile: never a note, a visit id, a user id or a time finer than the month -----

export const PublicMuseum = z.strictObject({ slug: Slug, name: Name, name_en: Name.nullable(), place: Place });
export type PublicMuseum = z.infer<typeof PublicMuseum>;

export const PublicVisit = z.strictObject({
  museum: PublicMuseum,
  visited_month: Month.nullable(),
  visits: z.number().int().min(1),
});
export type PublicVisit = z.infer<typeof PublicVisit>;

export const PublicVisitList = z.strictObject({ items: z.array(PublicVisit).max(50), next: Cursor.nullable() });
export type PublicVisitList = z.infer<typeof PublicVisitList>;

export const PublicWishlist = z.strictObject({
  items: z.array(z.strictObject({ museum: PublicMuseum })).max(50),
  next: Cursor.nullable(),
});
export type PublicWishlist = z.infer<typeof PublicWishlist>;

/** `null` = private. The first page of each public list is inline, so the SSR loads one path. */
export const UserProfile = z.strictObject({
  handle: Handle,
  display_name: z.string().max(DISPLAY_NAME_MAX),
  member_since: Month,
  indexable: z.boolean(),
  progress: Progress.nullable(),
  visits: PublicVisitList.nullable(),
  wishlist: PublicWishlist.nullable(),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const PublicListQuery = z.strictObject({ cursor: Cursor.optional(), limit: Limit });
export type PublicListQuery = z.infer<typeof PublicListQuery>;
