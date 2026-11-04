import { z } from 'zod';

// The opaque keyset cursor of GET /museums (A§14): base64url of compact JSON, in one of two modes.
// Name mode (no `q`): the last row's sort key and id. Search mode (with `q`): its tier (1 full-text,
// 2 name trigram, 3 alias trigram), score, sort key and id. Decoding is strict: base64url in its
// canonical form, JSON, then a strict zod schema per mode, so every value that reaches SQL has been
// checked first (the 22P02 gotcha: PostgreSQL logs a bad cast's value). A failure is a typed result,
// never a throw, and never quotes the input.

export type NameCursor = { m: 'n'; k: string; i: string };
export type SearchCursor = { m: 's'; t: 1 | 2 | 3; s: number; k: string; i: string };
export type PageCursor = NameCursor | SearchCursor;
export type DecodedCursor = { ok: true; cursor: PageCursor } | { ok: false };

/** The sort key is the lower-case unaccented name: at most 250 characters, a little more after unaccent. */
const MAX_KEY_UNITS = 1000;
/**
 * Input guard before any decoding; the contract's `Cursor` allows the same length. The worst key is
 * 250 characters that JSON escapes as `\u00XX` (6 bytes each): about 2,100 characters of base64url.
 */
const MAX_ENCODED = 4096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// A key never holds a NUL (PostgreSQL text cannot) or a lone surrogate (it would not survive UTF-8).
const key = z
  .string()
  .max(MAX_KEY_UNITS)
  .refine((s) => s.isWellFormed() && !s.includes('\0'), { message: 'key' });
const id = z.string().regex(UUID_RE);

const NameSchema = z.strictObject({ m: z.literal('n'), k: key, i: id });
const SearchSchema = z.strictObject({
  m: z.literal('s'),
  t: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  s: z.number().finite().min(0),
  k: key,
  i: id,
});
const CursorSchema = z.discriminatedUnion('m', [NameSchema, SearchSchema]);

export function encodeCursor(c: PageCursor): string {
  const json =
    c.m === 'n'
      ? JSON.stringify({ m: 'n', k: c.k, i: c.i })
      : JSON.stringify({ m: 's', t: c.t, s: normaliseScore(c.s), k: c.k, i: c.i });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** A score is finite and not negative; -0 becomes 0 so a cursor never differs by a sign of zero. */
function normaliseScore(s: number): number {
  if (!Number.isFinite(s) || s < 0) throw new RangeError('cursor score');
  return s === 0 ? 0 : s;
}

export function decodeCursor(text: string): DecodedCursor {
  if (text.length === 0 || text.length > MAX_ENCODED || !BASE64URL_RE.test(text)) return { ok: false };
  const bytes = Buffer.from(text, 'base64url');
  // Canonical form only: Buffer ignores stray padding bits, so re-encoding must give the input back.
  if (bytes.toString('base64url') !== text) return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false };
  }
  const parsed = CursorSchema.safeParse(value);
  return parsed.success ? { ok: true, cursor: parsed.data } : { ok: false };
}
