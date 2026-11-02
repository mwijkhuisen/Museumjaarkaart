import { type RawBuilder, sql, type Transaction } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { DB } from '../db/types.ts';

// Catalogue search (A§14, ADR-0015). Reads only pub_museum and pub_museum_alias, so it runs as mjk_api
// and as mjk_ssr (P1c's server rendering reuses it). `q` reaches SQL only as a bound parameter, only
// after its contract schema (Q) validated it, and only through websearch_to_tsquery (never to_tsquery)
// and the trigram operators (never `similarity(…) > x`, which no index serves).
//
// Three index-served branches, one row per museum from the best of them:
//   tier 1  full text: `search @@ websearch_to_tsquery('dutch', unaccent(q))`, score ts_rank
//   tier 2  the name by trigram: `unaccent(q) <% name_folded`, score word_similarity
//   tier 3  an alias by trigram, the same: a museum found only through an alias ranks after name matches
// Each branch keeps the operator and the indexed expression exactly as the GIN indexes of
// 20261103000001_search.sql define them; search-explain.int.test.ts proves the plans use them.

/**
 * pg_trgm.word_similarity_threshold of the `<%` branches (PostgreSQL's default is 0.6). Tuned on the
 * seeded 1,400-museum catalogue (search.int.test.ts). Hits for typos of name words, per threshold:
 *   - "tylers" (Teylers) has word similarity 0.57: found at 0.55 and below, missed at 0.6;
 *   - "rijksmusem" finds 15 museums at 0.5, 8 at 0.55 and 0.6 (the Rijksmuseum names that share the word);
 *   - the exact word "rijksmuseum" adds 95 trigram hits after its full-text hits at 0.5 (every
 *     "...smuseum" compound), 12 at 0.55 and 11 at 0.6.
 * 0.55 keeps the short-name typo and drops the noise of 0.5.
 */
export const WORD_SIMILARITY_THRESHOLD = 0.55;

export type SearchTx = Transaction<DB>;

/** SET LOCAL pg_trgm.word_similarity_threshold: the value is a constant, set inside the transaction. */
export async function setThreshold(trx: SearchTx): Promise<void> {
  await sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY_THRESHOLD)}, true)`.execute(
    trx,
  );
}

const folded = (q: string): RawBuilder<string> => sql`public.mjk_unaccent(${q})`;

/** Tier 1: ids and ts_rank of the full-text matches. */
export function ftsBranch(q: string): RawBuilder<unknown> {
  const query = sql`websearch_to_tsquery('pg_catalog.dutch', ${folded(q)})`;
  return sql`SELECT m.id, 1 AS tier, ts_rank(m.search, ${query})::float8 AS score
    FROM pub_museum m WHERE m.search @@ ${query}`;
}

/** Tier 2: ids and word_similarity of the names that pass the threshold. */
export function nameBranch(q: string): RawBuilder<unknown> {
  return sql`SELECT m.id, 2 AS tier, word_similarity(${folded(q)}, m.name_folded)::float8 AS score
    FROM pub_museum m WHERE ${folded(q)} <% m.name_folded`;
}

/** Tier 3: the museum of each alias that passes the threshold. */
export function aliasBranch(q: string): RawBuilder<unknown> {
  return sql`SELECT a.museum_id AS id, 3 AS tier, word_similarity(${folded(q)}, a.alias_folded)::float8 AS score
    FROM pub_museum_alias a WHERE ${folded(q)} <% a.alias_folded`;
}

/** One row per matching museum: its lowest tier and that tier's best score. Columns: id, tier, score. */
export function matches(q: string): RawBuilder<unknown> {
  return sql`SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (${ftsBranch(q)} UNION ALL ${nameBranch(q)} UNION ALL ${aliasBranch(q)}) h
    ORDER BY h.id, h.tier, h.score DESC`;
}

export const SUGGEST_LIMIT = 10;

export type SuggestRow = { slug: string; name: string; place: string | null; municipality_name: string | null };

/** Up to 10 names for the search box: the same search, no filters, best first. */
export async function suggestMuseums(db: Db, q: string): Promise<SuggestRow[]> {
  return db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await setThreshold(trx);
      const { rows } = await sql<SuggestRow>`
        WITH best AS (${matches(q)})
        SELECT m.slug, m.name, m.place, m.municipality_name
        FROM best b JOIN pub_museum m ON m.id = b.id
        ORDER BY b.tier, -b.score, m.sort_name, m.id
        LIMIT ${SUGGEST_LIMIT}`.execute(trx);
      return rows;
    });
}
