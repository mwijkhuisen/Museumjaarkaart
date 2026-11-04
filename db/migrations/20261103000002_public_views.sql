-- migrate:up
-- P1b (A§8): the public views and the public search function. Every public query (the api now,
-- the ssr role as mjk_ssr from P1c) reads only these, so `hidden` is filtered in exactly one place
-- per object and the curated and internal columns never leave the database. mjk_ssr gets no table.
--
-- The views are the isolation boundary for mjk_ssr: a compromised ssr process can send any SQL it
-- likes, and must still see public rows only. So every view is WITH (security_barrier): the planner
-- never evaluates a caller's qual below the view's own WHERE and joins unless the qual is leakproof
-- (it cannot raise an error or otherwise reveal the values it reads). Without the barrier, a qual
-- such as `CASE WHEN alias = '<a hidden museum's alias>' THEN 1/0 ELSE 1 END = 1` runs on the base
-- table before `NOT hidden` and turns a hidden row into an error (views.int.test.ts proves both).
-- The text, uuid, date and float8 comparisons that the list, the keyset, the province and
-- municipality filters, the detail and near-me use are leakproof and still reach the indexes; `@>`,
-- `@@`, `<%` and functions such as mjk_unaccent are not, so search does not go through the views
-- (pub_search below). What the barrier does not stop: plan instrumentation. EXPLAIN (ANALYZE) shows
-- `Rows Removed by Filter` for hidden rows that a leakproof qual reaches on an index, which confirms a
-- guessed hidden slug or id (A§8 records this residual; views.int.test.ts pins it).
--
-- The views are owned by mjk_migrator (the migration runs as it) and are not security_invoker
-- (the callers hold no table grants).

CREATE VIEW pub_museum WITH (security_barrier) AS
SELECT
  m.id,
  m.slug,
  m.name,
  m.name_en,
  m.description_nl,
  m.description_en,
  m.street,
  m.house_number,
  m.postcode,
  m.place,
  m.municipality_code,
  mu.name AS municipality_name,
  mu.province_code,
  m.lat,
  m.lon,
  m.website,
  m.museumnl_url,
  m.registered,
  m.categories,
  m.museumkaart_status,
  m.mk_since,
  m.mk_until,
  m.mk_last_verified_at,
  m.admission_adult_cents,
  m.price_verified_at,
  m.photo_policy,
  m.closed_on,
  m.temp_closed,
  m.temp_closed_until,
  m.search,
  public.mjk_unaccent(m.name) AS name_folded,
  lower(public.mjk_unaccent(m.name)) AS sort_name,
  EXISTS (
    SELECT 1 FROM mk_list l JOIN mk_list_member mm ON mm.list_version_id = l.list_version_id
    WHERE mm.museum_id = m.id
  ) AS mk_list_member
FROM museum m
LEFT JOIN municipality mu ON mu.cbs_code = m.municipality_code
WHERE NOT m.hidden;

CREATE VIEW pub_museum_alias WITH (security_barrier) AS
SELECT a.museum_id, a.alias, public.mjk_unaccent(a.alias) AS alias_folded
FROM museum_alias a
JOIN pub_museum pm ON pm.id = a.museum_id;

-- Never a row whose old slug is the museum's current slug (a museum may take its old slug back).
CREATE VIEW pub_slug_redirect WITH (security_barrier) AS
SELECT r.old_slug, pm.slug
FROM museum_slug_redirect r
JOIN pub_museum pm ON pm.id = r.museum_id
WHERE r.old_slug <> pm.slug;

CREATE VIEW pub_province WITH (security_barrier) AS
SELECT p.code, p.name_nl, p.name_en, count(pm.id)::int AS museum_count
FROM province p
LEFT JOIN pub_museum pm ON pm.province_code = p.code
GROUP BY p.code, p.name_nl, p.name_en;

-- N stays as published (A§7.5); no row before the first published version.
CREATE VIEW pub_mk_list WITH (security_barrier) AS
SELECT published_on, n::int AS n
FROM mk_list;

GRANT SELECT ON pub_museum, pub_museum_alias, pub_slug_redirect, pub_province, pub_mk_list TO mjk_api, mjk_ssr;

-- Catalogue search (A§14, ADR-0015): the museums that match `q`, one row per museum with its lowest
-- tier and that tier's best score. Through the barrier views, `@@` and `<%` (not leakproof) could
-- not reach their GIN indexes, so the three index-served branches read the tables here, as the
-- owner mjk_migrator (SECURITY DEFINER), and each one applies `NOT m.hidden` itself:
--   tier 1  full text: search @@ websearch_to_tsquery('dutch', unaccent(q)), score ts_rank
--   tier 2  the name by trigram: unaccent(q) <% unaccent(name), score word_similarity
--   tier 3  an alias by trigram, the same; a museum found only through an alias ranks after names
-- Each branch keeps the operator and the indexed expression exactly as the GIN indexes of
-- 20261103000001_search.sql define them; search-explain.int.test.ts explains this very body.
--
-- Why a definer function is safe here: the body is static SQL (no EXECUTE, no dynamic SQL, no
-- format()); `q` is only the bound value $1, passed to mjk_unaccent, websearch_to_tsquery (never
-- to_tsquery) and the trigram operators; every name is schema-qualified (pg_trgm's operators and
-- functions live in public) and the search_path is pinned, so a caller cannot redirect a name; it
-- returns ids of visible museums only, plus a tier and a score, which the caller joins to the
-- barrier pub_museum. EXECUTE belongs to mjk_api and mjk_ssr only.
--
-- The body is a string (not BEGIN ATOMIC), so the EXPLAIN test can read it from pg_proc.prosrc.
--
-- pg_trgm.word_similarity_threshold (PostgreSQL's default is 0.6) is set here, the one source.
-- Tuned on the seeded 1,400-museum catalogue (search.int.test.ts). Hits for typos of name words:
--   - "tylers" (Teylers) has word similarity 0.57: found at 0.55 and below, missed at 0.6;
--   - "rijksmusem" finds 15 museums at 0.5, 8 at 0.55 and 0.6 (the Rijksmuseum names that share the word);
--   - the exact word "rijksmuseum" adds 95 trigram hits after its full-text hits at 0.5 (every
--     "...smuseum" compound), 12 at 0.55 and 11 at 0.6.
-- 0.55 keeps the short-name typo and drops the noise of 0.5.
CREATE FUNCTION public.pub_search(q text)
RETURNS TABLE (id uuid, tier integer, score double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET pg_trgm.word_similarity_threshold = '0.55'
AS $body$
SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
FROM (
  SELECT m.id, 1 AS tier,
         pg_catalog.ts_rank(m.search,
           pg_catalog.websearch_to_tsquery('pg_catalog.dutch', public.mjk_unaccent($1)))::float8 AS score
    FROM public.museum m
   WHERE NOT m.hidden
     AND m.search OPERATOR(pg_catalog.@@)
         pg_catalog.websearch_to_tsquery('pg_catalog.dutch', public.mjk_unaccent($1))
  UNION ALL
  SELECT m.id, 2 AS tier,
         public.word_similarity(public.mjk_unaccent($1), public.mjk_unaccent(m.name))::float8 AS score
    FROM public.museum m
   WHERE NOT m.hidden
     AND public.mjk_unaccent($1) OPERATOR(public.<%) public.mjk_unaccent(m.name)
  UNION ALL
  SELECT a.museum_id AS id, 3 AS tier,
         public.word_similarity(public.mjk_unaccent($1), public.mjk_unaccent(a.alias))::float8 AS score
    FROM public.museum_alias a
    JOIN public.museum m ON m.id OPERATOR(pg_catalog.=) a.museum_id
   WHERE NOT m.hidden
     AND public.mjk_unaccent($1) OPERATOR(public.<%) public.mjk_unaccent(a.alias)
) h
ORDER BY h.id, h.tier, h.score DESC
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_search(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_search(text) TO mjk_api, mjk_ssr;

-- migrate:down
DROP FUNCTION public.pub_search(text);
DROP VIEW pub_mk_list;
DROP VIEW pub_province;
DROP VIEW pub_slug_redirect;
DROP VIEW pub_museum_alias;
DROP VIEW pub_museum;
