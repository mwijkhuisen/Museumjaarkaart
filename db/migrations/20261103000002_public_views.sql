-- migrate:up
-- P1b (A§8): the public views. Every public query (the api now, the ssr role as mjk_ssr from
-- P1c) reads only these, so `hidden` is filtered in exactly one place (pub_museum) and the
-- curated and internal columns never leave the database. mjk_ssr gets no table at all.
--
-- The views are owned by mjk_migrator (the migration runs as it) and are neither
-- security_invoker (the callers hold no table grants) nor security_barrier: a barrier would stop
-- the planner from using the GIN indexes for the non-leakproof @@ and <% operators. No login
-- runs user-written SQL, and mjk_api reads the tables anyway.

CREATE VIEW pub_museum AS
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

CREATE VIEW pub_museum_alias AS
SELECT a.museum_id, a.alias, public.mjk_unaccent(a.alias) AS alias_folded
FROM museum_alias a
JOIN pub_museum pm ON pm.id = a.museum_id;

-- Never a row whose old slug is the museum's current slug (a museum may take its old slug back).
CREATE VIEW pub_slug_redirect AS
SELECT r.old_slug, pm.slug
FROM museum_slug_redirect r
JOIN pub_museum pm ON pm.id = r.museum_id
WHERE r.old_slug <> pm.slug;

CREATE VIEW pub_province AS
SELECT p.code, p.name_nl, p.name_en, count(pm.id)::int AS museum_count
FROM province p
LEFT JOIN pub_museum pm ON pm.province_code = p.code
GROUP BY p.code, p.name_nl, p.name_en;

-- N stays as published (A§7.5); no row before the first published version.
CREATE VIEW pub_mk_list AS
SELECT published_on, n::int AS n
FROM mk_list;

GRANT SELECT ON pub_museum, pub_museum_alias, pub_slug_redirect, pub_province, pub_mk_list TO mjk_api, mjk_ssr;

-- migrate:down
DROP VIEW pub_mk_list;
DROP VIEW pub_province;
DROP VIEW pub_slug_redirect;
DROP VIEW pub_museum_alias;
DROP VIEW pub_museum;
