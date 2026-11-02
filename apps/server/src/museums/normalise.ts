// Name normalisation for the matcher (A§7.3, plan §2.3). Pure and idempotent.
// The output is ASCII [a-z0-9 ] only: lower case, accents folded, punctuation
// and any other character turned into a space, stop-words dropped. Place names stay.

/**
 * Whole-token stop-words (A§7.3). `t` is what `'t` leaves after punctuation becomes a space. The
 * owner's full recording (O1, 2026-11-02) added the legal-form and abbreviation noise of the RCE
 * names: `stg` (stichting), `gem` (gemeente, "Markiezenhof, Gem. Bergen Op Zoom"), `mus` (museum,
 * "Mus Willet Holthuijzen") and `in` ("In de Gecroonde Duyvekater").
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'museum',
  'musea',
  'mus',
  'het',
  'de',
  't',
  'van',
  'der',
  'den',
  'en',
  'in',
  'stichting',
  'stg',
  'gem',
]);

/** Letters NFKD does not decompose. Applied after lower-casing, so only lower-case keys. */
const FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ĳ: 'ij',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ħ: 'h',
  ı: 'i',
  ŧ: 't',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLDS).join('')}]`, 'gu');

export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(FOLD_RE, (c) => FOLDS[c] ?? ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && !STOP_WORDS.has(w))
    .join(' ');
}
