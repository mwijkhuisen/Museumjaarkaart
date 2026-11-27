import { z } from 'zod';
import { Handle } from './auth.ts';
import { BAD_TEXT_CHAR, Cursor, codePoints, isStorable, Slug } from './common.ts';
import { Limit } from './queries.ts';

// Photos (P3b, A§12, A§14). Browser-safe: zod only, no Node API. The server's own limits are in
// apps/server/src/media/limits.ts; the values the browser also needs live here.

const MiB = 1024 * 1024;

/** The chunk size of `PUT /uploads/:id/chunks/:n` (8 MiB, A§12); the last chunk is the remainder. */
export const CHUNK_BYTES = 8 * MiB;
/** A photo's upper size (A§12's 25 MB, as binary units like the chunk). */
export const PHOTO_MAX_BYTES = 25 * MiB;
/** The three types the file input accepts and `complete` checks by magic bytes (never `image/heic`, A§12). */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** A photo's alt text (A§12, A§15.5). */
export const ALT_TEXT_MAX = 250;
/** Photos per review (A§12). A member has one review per museum, so the server counts per member and museum. */
export const PHOTOS_PER_REVIEW = 10;

/** `media.state` (A§8). */
export const MEDIA_STATES = [
  'uploading',
  'quarantined',
  'processing',
  'pending_review',
  'approved',
  'rejected',
  'removed',
  'failed',
] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

/** The variant formats on R2 and in quarantine. */
export const VARIANT_FORMATS = ['avif', 'webp'] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

export const MediaStateSchema = z.enum(MEDIA_STATES);
export const PhotoTypeSchema = z.enum(PHOTO_TYPES);

/** An upload or photo id from a path: a lower-case uuid, checked before any SQL or path is built. */
export const MediaIdParam = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** A chunk index from a path: digits only; the route checks it against the upload's chunk count. */
export const ChunkIndexParam = z.string().regex(/^[0-9]{1,2}$/);

/**
 * `POST /uploads` (A§14). The size and the type are checked by the route (422 `["size"]`, 415), so the schema
 * takes any positive size and short type; a consent that is not `true` is a 422 `["consents"]`, not a 400.
 */
export const UploadCreate = z.strictObject({
  kind: z.literal('photo'),
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  type: z.string().min(1).max(100),
  museum_id: z.uuid(),
  review_id: z.uuid().optional(),
  consents: z.strictObject({ own_photo: z.boolean(), no_people: z.boolean(), no_artwork: z.boolean() }),
});
export type UploadCreate = z.infer<typeof UploadCreate>;

export const UploadCreated = z.strictObject({
  id: z.uuid(),
  chunk_size: z.literal(CHUNK_BYTES),
  chunk_count: z.number().int().min(1).max(4),
});
export type UploadCreated = z.infer<typeof UploadCreated>;

/** `POST /uploads/:id/complete`: the whole file's sha256, lower-case hex. */
export const UploadComplete = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** `GET /uploads/:id` and the 202 of `complete`: the state, its fixed code and, once approved, the variant keys. */
export const UploadStatus = z.strictObject({
  id: z.uuid(),
  state: MediaStateSchema,
  error_code: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .nullable(),
  keys: z.array(z.string().regex(/^p\/[0-9a-f]{32}\/[0-9]{1,4}\.(avif|webp)$/)).max(8),
});
export type UploadStatus = z.infer<typeof UploadStatus>;

// ---- Photos on reviews (P3b WP5) ---------------------------------------------------------------------

/** The widths a variant can have (A§12: 400, 1200, 2000, or the source's own smaller width). */
const Widths = z.array(z.int().min(1).max(2000)).max(4);
const Key = z.string().regex(/^[0-9a-f]{32}$/);
const Dimension = z.int().min(1).max(100000);
const AltOut = z.string().min(1).max(ALT_TEXT_MAX).nullable();

/**
 * A published photo (from `pub_media`: approved, on a visible review). The web builds
 * `https://media.<domain>/p/<public_key>/<width>.<avif|webp>` from `public_key` and `widths` (the AVIF widths).
 */
export const PublicPhoto = z.strictObject({
  id: z.uuid(),
  width: Dimension,
  height: Dimension,
  alt_text: AltOut,
  public_key: Key,
  widths: Widths,
});
export type PublicPhoto = z.infer<typeof PublicPhoto>;

/**
 * A member's own photo of a review, in any state but failed and removed. `public_key` and `widths` are set only
 * once the photo is approved; until then the author sees it through `GET /uploads/:id/preview`.
 */
export const OwnPhoto = z.strictObject({
  id: z.uuid(),
  state: MediaStateSchema,
  width: Dimension.nullable(),
  height: Dimension.nullable(),
  alt_text: AltOut,
  public_key: Key.nullable(),
  widths: Widths,
});
export type OwnPhoto = z.infer<typeof OwnPhoto>;

/** An alt text: one line, 1 to 250 code points, P3a's text rule (no control, separator or bidi character). */
export function isAltText(s: string): boolean {
  const n = codePoints(s);
  return isStorable(s) && n >= 1 && n <= ALT_TEXT_MAX && !BAD_TEXT_CHAR.test(s);
}

/** `PATCH /media/:id`: trimmed text that passes the rule, or `null` to clear it. */
export const MediaAltPatch = z.strictObject({
  alt_text: z
    .string()
    .max(4 * ALT_TEXT_MAX)
    .nullable()
    .transform((s, ctx) => {
      const t = s === null ? null : s.trim();
      if (t !== null && !isAltText(t)) ctx.issues.push({ code: 'custom', message: 'not alt text', input: s });
      return t;
    }),
});
export type MediaAltPatch = z.output<typeof MediaAltPatch>;

/** `GET /uploads/:id/preview?w=`: the WebP variant at most this wide (the smallest when none is). */
export const PreviewQuery = z.strictObject({ w: z.enum(['400', '1200']).prefault('400') });

/** A photo in a gallery list: the photo, the review it belongs to, its author's handle and the museum. */
export const GalleryPhoto = PublicPhoto.extend({
  review_id: z.uuid(),
  author_handle: Handle.nullable(),
  museum: z.strictObject({
    id: z.uuid(),
    slug: Slug,
    name: z.string().min(1).max(250),
    name_en: z.string().max(250).nullable(),
  }),
});
export type GalleryPhoto = z.infer<typeof GalleryPhoto>;

export const PhotoListQuery = z.strictObject({ limit: Limit, cursor: Cursor.optional() });
export type PhotoListQuery = z.infer<typeof PhotoListQuery>;

/** `GET /museums/:slug/photos` and `GET /users/:handle/photos`, newest first, keyset-paged like the review lists. */
export const PhotoList = z.strictObject({ items: z.array(GalleryPhoto).max(50), next_cursor: Cursor.nullable() });
export type PhotoList = z.infer<typeof PhotoList>;
