import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';

// Catalogue search (A§14, ADR-0015). The matching runs in one SQL function, public.pub_search(q)
// (migration 20261103000002_public_views.sql): SECURITY DEFINER with a pinned search_path and the
// pinned pg_trgm.word_similarity_threshold (0.55, tuned there), static SQL, visible museums only. The
// pub_* views are security_barrier, so the non-leakproof `@@` and `<%` could not reach their GIN
// indexes through them; the function reads the tables instead. It is executable by mjk_api and
// mjk_ssr (P1c's server rendering reuses this module). `q` reaches SQL only as a bound parameter,
// only after its contract schema (Q) validated it.
//
// Three index-served branches inside the function, one row per museum from the best of them:
//   tier 1  full text (websearch_to_tsquery, never to_tsquery), score ts_rank
//   tier 2  the name by trigram (`<%`), score word_similarity
//   tier 3  an alias by trigram, the same: a museum found only through an alias ranks after name matches
// search-explain.int.test.ts explains the function's own body and proves the plans use the indexes.

/** One row per matching visible museum: its lowest tier and that tier's best score. Columns: id, tier, score. */
export function matches(q: string): RawBuilder<unknown> {
  return sql`SELECT s.id, s.tier, s.score FROM public.pub_search(${q}) s`;
}

export const SUGGEST_LIMIT = 10;

export type SuggestRow = { slug: string; name: string; place: string | null; municipality_name: string | null };

/** Up to 10 names for the search box: the same search, no filters, best first. */
export async function suggestMuseums(db: Db, q: string): Promise<SuggestRow[]> {
  return db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const { rows } = await sql<SuggestRow>`
        WITH best AS (${matches(q)})
        SELECT m.slug, m.name, m.place, m.municipality_name
        FROM best b JOIN pub_museum m ON m.id = b.id
        ORDER BY b.tier, -b.score, m.sort_name, m.id
        LIMIT ${SUGGEST_LIMIT}`.execute(trx);
      return rows;
    });
}
