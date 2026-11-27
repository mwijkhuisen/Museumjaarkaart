import { z } from 'zod';

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
