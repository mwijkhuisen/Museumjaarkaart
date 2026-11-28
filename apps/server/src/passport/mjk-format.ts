// The `mjk` v1 file (A§10): what the export job writes into `export.json` and what the `mjk` import
// reads back (only `visits` and `wishlist`; see import/mjk.ts). Bump `version` for any change that an
// old reader would misread.

import { IsoDate, IsoDateTime, MediaStateSchema, Rating, Settings, Slug } from '@mjk/contracts';
import { z } from 'zod';

/** The export's two CSV files. The CSV import reads `visits.csv` back through its column aliases. */
export const VISITS_CSV_HEADER = ['museum_id', 'museum', 'place', 'visited_on', 'note'] as const;
export const WISHLIST_CSV_HEADER = ['museum_id', 'museum', 'place', 'added_on'] as const;

const MjkMuseum = z.strictObject({
  id: z.uuid(),
  slug: Slug,
  name: z.string(),
  place: z.string().nullable(),
  wikidata_qid: z.string().nullable(),
});

const aspect = Rating.nullable();
const MjkReviewContent = {
  rating: Rating,
  collection: aspect,
  presentation: aspect,
  kid_friendly: aspect,
  accessibility: aspect,
  facilities: aspect,
  value_for_money: aspect,
  body: z.string().nullable(),
};

export const MjkExportV1 = z.strictObject({
  format: z.literal('mjk'),
  version: z.literal(1),
  exported_at: IsoDateTime,
  account: z.strictObject({
    handle: z.string(),
    display_name: z.string(),
    email: z.string(),
    created_at: IsoDateTime,
    email_verified_at: IsoDateTime.nullable(),
    age_confirmed_at: IsoDateTime.nullable(),
    terms_version: z.string().nullable(),
    terms_accepted_at: IsoDateTime.nullable(),
    settings: Settings,
  }),
  visits: z.array(
    z.strictObject({
      museum: MjkMuseum,
      visited_on: IsoDate.nullable(),
      note: z.string().nullable(),
      source: z.enum(['manual', 'bulk', 'import']),
      created_at: IsoDateTime,
    }),
  ),
  wishlist: z.array(z.strictObject({ museum: MjkMuseum, created_at: IsoDateTime })),
  // P3a: the member's own reviews with their revisions, oldest first. Optional: the importer ignores the key and
  // an older v1 file has none.
  reviews: z
    .array(
      z.strictObject({
        museum: MjkMuseum,
        visited_on: IsoDate.nullable(),
        ...MjkReviewContent,
        state: z.enum(['visible', 'removed']),
        created_at: IsoDateTime,
        edited_at: IsoDateTime.nullable(),
        revisions: z.array(z.strictObject({ ...MjkReviewContent, created_at: IsoDateTime })),
      }),
    )
    .optional(),
  // P3b: the member's photos as metadata only (no file, key, hash or address). Optional like `reviews`.
  photos: z
    .array(
      z.strictObject({
        id: z.uuid(),
        review_id: z.uuid().nullable(),
        museum_slug: Slug,
        state: MediaStateSchema,
        created_at: IsoDateTime,
        alt_text: z.string().nullable(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
      }),
    )
    .optional(),
  sessions: z.array(
    z.strictObject({ host: z.string(), method: z.string(), created_at: IsoDateTime, last_used_at: IsoDateTime }),
  ),
  // P2b's passkeys: the metadata only, never the credential id or the public key.
  passkeys: z.array(
    z.strictObject({
      name: z.string().nullable(),
      transports: z.array(z.string()),
      backed_up: z.boolean(),
      created_at: IsoDateTime,
      last_used_at: IsoDateTime.nullable(),
    }),
  ),
  imports: z.array(
    z.strictObject({
      format: z.string(),
      state: z.string(),
      created_at: IsoDateTime,
      confirmed_at: IsoDateTime.nullable(),
      rows: z.array(z.unknown()),
    }),
  ),
  exports: z.array(z.strictObject({ state: z.string(), created_at: IsoDateTime, expires_at: IsoDateTime.nullable() })),
  content_ip_log: z.array(
    z.strictObject({ target_kind: z.string(), target_id: z.uuid(), ip: z.string(), created_at: IsoDateTime }),
  ),
});
export type MjkExportV1 = z.infer<typeof MjkExportV1>;
