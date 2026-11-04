// A TypeScript port of pg_trgm's similarity() (A§7.3, plan §2.3), so the matcher
// stays pure. trigram.int.test.ts proves it equals PostgreSQL 18 on many pairs.
//
// What pg_trgm does (generate_trgm / cnt_sml):
// - words are runs of alphanumerics, lower-cased; each is padded "  w " and cut
//   into every 3-character window; the trigrams of all words form one set
// - similarity = shared / union as a float4 (the documented behaviour: similarity('word', 'two words') = 0.363636)
// - an empty set on either side gives 0

const WORD = /[\p{L}\p{N}]+/gu;

export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const [word] of s.toLowerCase().matchAll(WORD)) {
    const chars = Array.from(`  ${word} `);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

/** Similarity of two trigram sets, rounded to float4 like pg_trgm's `real`. */
export function similaritySets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return Math.fround(shared / (a.size + b.size - shared));
}

export function similarity(a: string, b: string): number {
  return similaritySets(trigrams(a), trigrams(b));
}
