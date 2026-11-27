import { z } from 'zod';

// The passport's contracts (P2c): visits, the wishlist, progress and € saved, imports, exports and
// public profiles. The numbers are Q6's, still [U] until P4 tunes them (A§10, A§14).

/** A visit's note, in characters. */
export const VISIT_NOTE_MAX = 2000;
/** Museums ticked in one `POST /me/visits/bulk`. */
export const BULK_MAX = 200;
/** Rows in one import file. */
export const IMPORT_ROWS_MAX = 5000;

/**
 * Text that can be stored: well-formed UTF-16 (no lone surrogate) and no U+0000. PostgreSQL's jsonb
 * and text refuse a NUL, and a lone surrogate becomes U+FFFD on the way to UTF-8.
 */
export const isStorable = (s: string): boolean => s.isWellFormed() && !s.includes('\u0000');
export const StorableText = z.string().refine(isStorable, { message: 'not storable text' });
