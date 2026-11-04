// Normalisation of untrusted source text at ingest (invariant 5). Wikidata and
// RCE strings are data: they are cleaned here once, so nothing downstream sees
// a control character, a bidi override or an over-long value.

export type CleanResult = { ok: true; value: string } | { ok: false; code: 'empty' | 'too_long' };

// C0 and C1 controls (tab, LF and CR are turned into spaces before this runs),
// bidi controls (U+061C, U+200E/F, U+202A-E, U+2066-9), zero-width and invisible
// formatting characters (soft hyphen, U+200B-D, U+2060-4, U+FEFF, U+180E) and tag characters.
const INVISIBLE_SOURCE =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]';
// Whitespace as the user sees it; JavaScript's \s lacks U+0085 (NEL).
const WHITESPACE = /[\s\u0085]+/gu;
const INVISIBLE = new RegExp(INVISIBLE_SOURCE, 'u');
const INVISIBLE_ALL = new RegExp(INVISIBLE_SOURCE, 'gu');

/** True when the string holds a control, bidi or zero-width character (or a lone surrogate). */
export function hasInvisible(s: string): boolean {
  return INVISIBLE.test(s) || !s.isWellFormed();
}

/** Number of Unicode code points (the database counts characters, not UTF-16 units). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * NFC, no controls, no bidi or zero-width characters, whitespace (CR and LF
 * included) collapsed to single spaces, trimmed. `max` counts code points.
 */
export function cleanText(s: string, max: number): CleanResult {
  // Whitespace first, so "a\nb" stays two words when the controls are stripped.
  const spaced = s.toWellFormed().replace(WHITESPACE, ' ');
  // NFC after the strip (removing a joiner can leave a composable pair), and collapse once more:
  // a few canonical decompositions turn into other space characters.
  const value = spaced.replace(INVISIBLE_ALL, '').normalize('NFC').replace(WHITESPACE, ' ').trim();
  if (value === '') return { ok: false, code: 'empty' };
  // UTF-16 units >= code points, so a value over 2 x max units is too long without counting.
  if (value.length > 2 * max || codePointLength(value) > max) return { ok: false, code: 'too_long' };
  return { ok: true, value };
}

const POSTCODE_INPUT = /^([1-9][0-9]{3}) ?([A-Za-z]{2})$/u;

/** `1071dj`, `1071 DJ` and ` 1071  dj ` become `1071 DJ`; anything else is undefined. */
export function postcode(s: string): string | undefined {
  // Cleaned first: a zero-width or no-break space inside source text must not hide a postcode.
  const text = cleanText(s, 20);
  const m = text.ok ? POSTCODE_INPUT.exec(text.value) : null;
  return m ? `${m[1]} ${m[2]?.toUpperCase()}` : undefined;
}
