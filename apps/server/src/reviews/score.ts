// The Bayesian score (P3a, owner answers Q2 and Q3). The one source of the two constants: the SQL of the
// stats job and of the list filters binds them, it never repeats the numbers.

/** The prior's weight: a museum counts as if it already had C ratings equal to the catalogue mean m. */
export const BAYES_C = 5;

/** An aspect's mean shows (and `kid_friendly=true` counts) from this many ratings of that aspect. */
export const ASPECT_MIN = 3;

/**
 * `(c·m + Σ ratings) / (c + n)`: the mean of `ratings` pulled toward `m`, the mean over every counted rating.
 * With no ratings it is `m`.
 *
 * Owner's caveat (Q3): the prior is the catalogue mean, so once m > 4.5 a museum with a single 5-star review
 * (score (5m + 5) / 6) still outranks one with many 4.6 ratings (about 4.6 for large n). The stats job computes
 * the same expression in SQL (`museum_stats.bayes_score`, unrounded); a test pins that they agree.
 */
export function bayes(c: number, m: number, ratings: readonly number[]): number {
  let sum = 0;
  for (const r of ratings) sum += r;
  return (c * m + sum) / (c + ratings.length);
}
