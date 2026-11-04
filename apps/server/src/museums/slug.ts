// Museum slugs (plan §2.1): made once at creation from the unaccented,
// lower-case name; on a collision `-<place>`, then `-2`, `-3`, …. Nothing
// changes a slug later; renames and old-slug redirects are P1b's.

const FOLD: Readonly<Record<string, string>> = {
  ß: 'ss',
  ĳ: 'ij',
  Ĳ: 'ij',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  þ: 'th',
  Þ: 'th',
};

const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '');

/** `[a-z0-9]` words joined by `-`, at most `max` characters (100 leaves room for the suffixes under the 120 cap). */
export function slugify(text: string, max = 100): string {
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[ßĳĲæÆœŒøØłŁđĐþÞ]/g, (c) => FOLD[c] ?? '')
    .toLowerCase();
  const slug = trimDashes(folded.replace(/[^a-z0-9]+/g, '-'));
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return trimDashes(dash > max / 2 ? cut.slice(0, dash) : cut);
}

/** A slug that is not in `taken`; the caller adds it to `taken`. */
export function uniqueSlug(name: string, place: string | null, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'museum';
  if (!taken.has(base)) return base;
  const where = place === null ? '' : slugify(place, 15);
  if (where !== '' && !taken.has(`${base}-${where}`)) return `${base}-${where}`;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
