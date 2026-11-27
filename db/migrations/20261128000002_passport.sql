-- migrate:up
-- P2c (A§8, A§10, A§13): the museum passport. Visits, the wishlist, the pending import and the export
-- request, plus what the public may see of them: the profile view, the province counts of the Museumkaart
-- list, and two SECURITY DEFINER functions for a member's public visit log and wishlist.
-- Every user_id cascades with the account (D10). The CHECKs match packages/contracts/src/passport.ts and
-- auth.ts; they are the last line behind the zod schemas. mjk_ssr gets no table here, only the views and
-- the two functions (A§8).

-- One row per visit. visited_on null means "earlier, date unknown". The phase file also names an import_id
-- column: left out on purpose, nothing reads it and the import row is purged after 7 days anyway.
CREATE TABLE visit (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  museum_id uuid NOT NULL REFERENCES museum (id),
  visited_on date,
  note text CHECK (char_length(note) BETWEEN 1 AND 2000),
  source text NOT NULL CHECK (source IN ('manual', 'bulk', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: two undated visits to one museum collide too (a re-run import is a no-op).
  CONSTRAINT visit_once UNIQUE NULLS NOT DISTINCT (user_id, museum_id, visited_on)
);
-- The member's own log, newest first, undated last (keyset paging).
CREATE INDEX visit_user_log_idx ON visit (user_id, visited_on DESC NULLS LAST, id DESC);

CREATE TABLE wishlist (
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  museum_id uuid NOT NULL REFERENCES museum (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, museum_id)
);

-- An uploaded import waiting for the member's confirmation. `rows` holds the parsed rows with their museum
-- match, never the raw file (data minimisation); the worker purges the row after 7 days.
CREATE TABLE visit_import (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format IN ('csv', 'mjk', 'museotrack', 'cultra')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed')),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
);
-- One pending import per member.
CREATE UNIQUE INDEX visit_import_pending_idx ON visit_import (user_id) WHERE state = 'pending';
CREATE INDEX visit_import_created_at_idx ON visit_import (created_at);

-- A request for the member's data export. The file itself is built by the worker and lives outside the
-- database (no path column); expires_at is set when it is ready.
CREATE TABLE data_export (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CHECK ((state = 'ready') = (expires_at IS NOT NULL))
);
-- One open export per member.
CREATE UNIQUE INDEX data_export_queued_idx ON data_export (user_id) WHERE state = 'queued';
CREATE INDEX data_export_user_idx ON data_export (user_id, created_at DESC);

-- The public profile (A§10): active members only. The visibility settings are read by jsonb equality, never
-- a cast, so a malformed value reads as private/false instead of raising. No id, no email, and the creation
-- time only as a month (a uuidv7 carries its creation time, so the id stays out).
-- handle is cast to text: citext equality is not leakproof, text equality is, so a `handle = $1` qual from a
-- compromised mjk_ssr still passes below the barrier. There is no index on handle::text on purpose:
-- pub_profile reads app_user by a sequential scan, so EXPLAIN (ANALYZE) as mjk_ssr shows in "Rows Removed by
-- Filter" how many accounts are not active (banned or deleted); it tells no handle apart. At beta size the
-- scan is cheap. (app_user's own handle index is not used by this view.)
CREATE VIEW pub_profile WITH (security_barrier) AS
SELECT
  u.handle::text AS handle,
  u.display_name,
  to_char(u.created_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS member_since,
  COALESCE(u.settings -> 'visits_visibility' = '"public"'::jsonb, false) AS visits_public,
  COALESCE(u.settings -> 'wishlist_visibility' = '"public"'::jsonb, false) AS wishlist_public,
  COALESCE(u.settings -> 'profile_indexable' = 'true'::jsonb, false) AS indexable
FROM app_user u
WHERE u.status = 'active';

-- The Museumkaart list per province: the newest version's members, hidden museums included, so that
-- sum(n) equals pub_mk_list.n (N as published, A§7.5). A museum without a known province counts under null.
CREATE VIEW pub_mk_list_province WITH (security_barrier) AS
SELECT mu.province_code, count(*)::int AS n
FROM mk_list l
JOIN mk_list_member mm ON mm.list_version_id = l.list_version_id
JOIN museum m ON m.id = mm.museum_id
LEFT JOIN municipality mu ON mu.cbs_code = m.municipality_code
GROUP BY mu.province_code;

-- A member's public visit log, by museum and month (never the day, the note or the source).
-- Why a function and not a view: only leakproof quals pass below a barrier, so a view's handle and
-- museum_id quals would reach the indexes, and EXPLAIN (ANALYZE) as mjk_ssr would show the rows that a
-- just-logged or private visit leaves behind ("Rows Removed by Filter"). A SECURITY DEFINER function is
-- opaque to EXPLAIN. Same safety argument as pub_search: static SQL (no EXECUTE, no format()), the handle
-- is only the bound value $1, every name is schema-qualified, the search_path is pinned.
-- A member with private visits, a banned or deleted one and an unknown handle all give the same empty result.
-- A visit becomes public 24 hours after it is logged (owner decision, Q1), so a fresh visit does not
-- announce that the member is at the museum right now. Handles are stored lower-case and the api checks
-- HANDLE_RE first; `=` on citext would need OPERATOR(public.=) under the pinned path, so the match is on text.
-- The plain operators below (=, ->, <=, -) resolve to pg_catalog's, the first entry of the pinned path.
CREATE FUNCTION public.pub_visit_log(p_handle text)
RETURNS TABLE (museum_id uuid, visited_month text, visits bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
SELECT v.museum_id,
       pg_catalog.to_char(v.visited_on, 'YYYY-MM') AS visited_month,
       pg_catalog.count(*) AS visits
  FROM public.app_user u
  JOIN public.visit v ON v.user_id = u.id
  JOIN public.museum m ON m.id = v.museum_id
 WHERE u.handle::text = $1
   AND u.status = 'active'
   AND u.settings -> 'visits_visibility' = '"public"'::pg_catalog.jsonb
   AND v.created_at <= pg_catalog.now() - interval '24 hours'
   AND NOT m.hidden
 GROUP BY 1, 2
 ORDER BY 1, 2
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_visit_log(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_visit_log(text) TO mjk_api, mjk_ssr;

-- A member's public wishlist: the same pattern and the same reasons, without the delay.
CREATE FUNCTION public.pub_wishlist_of(p_handle text)
RETURNS TABLE (museum_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
SELECT w.museum_id
  FROM public.app_user u
  JOIN public.wishlist w ON w.user_id = u.id
  JOIN public.museum m ON m.id = w.museum_id
 WHERE u.handle::text = $1
   AND u.status = 'active'
   AND u.settings -> 'wishlist_visibility' = '"public"'::pg_catalog.jsonb
   AND NOT m.hidden
 ORDER BY w.created_at, w.museum_id
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_wishlist_of(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_wishlist_of(text) TO mjk_api, mjk_ssr;

-- Grants (A§8: each phase grants its own tables). Nobody gets TRUNCATE, REFERENCES or TRIGGER.
-- mjk_api: a member edits only the date and the note of a visit; never user_id, museum_id, source.
GRANT SELECT, INSERT, DELETE ON visit TO mjk_api;
GRANT UPDATE (visited_on, note) ON visit TO mjk_api;
GRANT SELECT, INSERT, DELETE ON wishlist TO mjk_api;
GRANT SELECT, INSERT, DELETE ON visit_import TO mjk_api;
GRANT UPDATE (state, confirmed_at) ON visit_import TO mjk_api;
GRANT SELECT, INSERT ON data_export TO mjk_api;
GRANT UPDATE (state) ON data_export TO mjk_api;
GRANT SELECT ON pub_profile, pub_mk_list_province TO mjk_api, mjk_ssr;

-- mjk_worker: the export job and the purges. It reads what an export holds, never password_hash, never
-- session.id (the token hash), never a passkey's credential id or public key.
GRANT SELECT ON visit, wishlist, visit_import TO mjk_worker;
GRANT DELETE ON visit_import TO mjk_worker;
GRANT SELECT, DELETE ON data_export TO mjk_worker;
GRANT UPDATE (state, expires_at) ON data_export TO mjk_worker;
GRANT SELECT (id, handle, display_name, email_verified_at, age_confirmed_at, terms_version, terms_accepted_at,
  settings, created_at) ON app_user TO mjk_worker;
GRANT SELECT (user_id, host, method, created_at, last_used_at) ON session TO mjk_worker;
GRANT SELECT (user_id, target_kind, target_id, ip) ON content_ip_log TO mjk_worker;
-- P2b's passkeys: the export's metadata only, never credential_id or public_key.
GRANT SELECT (user_id, name, transports, backed_up, created_at, last_used_at) ON passkey TO mjk_worker;

-- migrate:down
REVOKE SELECT (user_id, name, transports, backed_up, created_at, last_used_at) ON passkey FROM mjk_worker;
REVOKE SELECT (user_id, target_kind, target_id, ip) ON content_ip_log FROM mjk_worker;
REVOKE SELECT (user_id, host, method, created_at, last_used_at) ON session FROM mjk_worker;
REVOKE SELECT (id, handle, display_name, email_verified_at, age_confirmed_at, terms_version, terms_accepted_at,
  settings, created_at) ON app_user FROM mjk_worker;
DROP FUNCTION public.pub_wishlist_of(text);
DROP FUNCTION public.pub_visit_log(text);
DROP VIEW pub_mk_list_province;
DROP VIEW pub_profile;
DROP TABLE data_export;
DROP TABLE visit_import;
DROP TABLE wishlist;
DROP TABLE visit;
