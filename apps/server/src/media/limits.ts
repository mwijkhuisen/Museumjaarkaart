// The photo pipeline's limits and paths (P3b, A§12, A§17.1, A§17.7). One place, named, so the [box] run can tune
// them (owner, Q5). The values the browser also needs come from @mjk/contracts.

export { ALT_TEXT_MAX, CHUNK_BYTES, PHOTO_MAX_BYTES, PHOTO_TYPES, PHOTOS_PER_REVIEW } from '@mjk/contracts';

const MiB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

/** limitInputPixels (A§12: ≈ 50 MP). */
export const PHOTO_MAX_PIXELS = 50_000_000;
/** Photos a member may start a day: the limiter bucket `photo_user_day` (A§9). */
export const PHOTOS_PER_DAY = 30;
/** Declared bytes per member over every photo that is not failed, removed or rejected (A§12: 1 GB). */
export const MEMBER_MAX_BYTES = 1024 * MiB;
/** Uploads in `uploading` per member; a 4th is a 429 (A§12). */
export const OPEN_UPLOADS_PER_MEMBER = 3;
/** Declared bytes over every open upload, site-wide; past it a 503 (A§12: 2 GB [U]). */
export const OPEN_UPLOAD_BYTES_SITE = 2048 * MiB;
/** The disk guard (A§17.7): under this free share, `POST /uploads` is a 503 `unavailable` [U]. */
export const DISK_MIN_FREE_PCT = 10;
/** A disk file older than this counts as under the guard (owner, Q6). mjk-tick writes it every 10 minutes. */
export const DISK_FILE_MAX_AGE_MS = 30 * 60 * 1000;
/** One photo's processing budget, from the moment the `media` role takes it (A§12: 120 s [U]). */
export const PHOTO_JOB_MS = 120_000;
/** A task the `media` role has not taken by then is retried later; the upload is kept. */
export const TAKE_MS = 30_000;
/** The `media` role exits when one task runs this long (sharp works off the event loop, so a timer still fires). */
export const MEDIA_WATCHDOG_MS = 130_000;
/** An upload still `uploading` after this is purged (A§12). */
export const UPLOAD_TTL_MS = 24 * HOUR_MS;
/** A photo not attached to a review after this is removed (owner, N1: 7 days). */
export const UNATTACHED_TTL_MS = 7 * 24 * HOUR_MS;
/** The variant widths (A§12); never upscaled. */
export const VARIANT_WIDTHS = [400, 1200, 2000] as const;

/** A§17.1's mounts. The api and the worker share quarantine; the worker and the `media` role share media-work. */
export const QUARANTINE_DIR = '/srv/mjk/quarantine';
export const MEDIA_WORK_DIR = '/srv/mjk/media-work';
/** mjk-tick's disk file lives here, the only part of /srv/mjk/state the api mounts (owner, Q6). */
export const GUARD_DIR = '/srv/mjk/state/guard';

/**
 * The widths to encode for a source of this width: every planned width below it, plus the source width itself
 * (capped at the largest planned width) when no planned width equals it. Never upscaled.
 */
export function variantWidths(sourceWidth: number): number[] {
  if (!Number.isInteger(sourceWidth) || sourceWidth < 1) throw new Error('variantWidths: invalid width');
  const top = Math.min(sourceWidth, Math.max(...VARIANT_WIDTHS));
  const widths: number[] = VARIANT_WIDTHS.filter((w) => w < top);
  widths.push(top);
  return widths;
}
