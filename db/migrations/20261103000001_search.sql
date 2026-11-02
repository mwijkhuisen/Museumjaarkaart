-- migrate:up
-- P1b (A§8, ADR-0015): search in PostgreSQL, and the old-slug redirects. The
-- `search` column and every index below are kept by triggers, never by a grant:
-- no login can write museum.search (grants.int.test.ts proves it).

-- unaccent() itself is only STABLE, so an index cannot use it. This wrapper is
-- IMMUTABLE. A SQL-standard body (BEGIN ATOMIC) binds its references when the
-- function is created, so a caller's search_path cannot redirect it. A change to
-- the unaccent rules file needs a REINDEX of the indexes below. EXECUTE stays with
-- PUBLIC (the default): the callers of the public views need it.
--
-- COST 250 (the default is 100). The planner under-prices the trigram predicates: their operators
-- (`<%`, `%`) carry the default cost of 1 although each call extracts and compares trigram sets.
-- Measured on PostgreSQL 18.6 with the seeded 1,400 museums (559 aliases), all in cache: one call of
-- this function takes ~1.0 us; the whole predicate `unaccent(q) <% unaccent(name)` ~4.5 us per row
-- (6.3 ms for 1,400 names, 0.1 to 0.25 ms through the GIN index); the planner's unit is ~5 us (a seq
-- scan of 2,000,000 rows costs 41,704 units and ran 215 ms). So the predicate costs ~0.9 units per
-- row, which is COST ~360 on this function (units = COST x cpu_operator_cost 0.0025). The smallest
-- round value with which the default planner picks museum_name_trgm_idx and museum_alias_trgm_idx
-- on the freshly seeded 1,400 museums (search-explain.int.test.ts) is 250; with 100 it scans both
-- tables. A fresh bulk load leaves the GIN pending list (fastupdate) unflushed, which inflates the
-- index cost estimates (name 486, alias 206, against 100 and 53 after a VACUUM); autovacuum flushes it.
CREATE FUNCTION public.mjk_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE COST 250
BEGIN ATOMIC
  SELECT public.unaccent('public.unaccent'::regdictionary, $1);
END;

-- The empty default is never stored: the BEFORE trigger below replaces it on every INSERT. It exists
-- so that the generated Kysely type is Generated<string> and an insert need not name the column.
ALTER TABLE museum ADD COLUMN search tsvector NOT NULL DEFAULT ''::tsvector;

-- The weighted document: name A; English name and aliases B; place and municipality C.
-- It runs as the writing login (mjk_worker, mjk_api), who hold SELECT on museum_alias and
-- municipality. Writing `search` directly only triggers a recompute (that is how the touch
-- functions below ask for one).
CREATE FUNCTION public.museum_search_refresh() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('pg_catalog.dutch', public.mjk_unaccent(NEW.name)), 'A')
    || setweight(to_tsvector('pg_catalog.dutch', public.mjk_unaccent(coalesce(NEW.name_en, ''))), 'B')
    || setweight(to_tsvector('pg_catalog.dutch', public.mjk_unaccent(coalesce(
         (SELECT string_agg(a.alias, ' ' ORDER BY a.alias) FROM public.museum_alias a WHERE a.museum_id = NEW.id),
         ''))), 'B')
    || setweight(to_tsvector('pg_catalog.dutch', public.mjk_unaccent(concat_ws(' ',
         NEW.place,
         (SELECT mu.name FROM public.municipality mu WHERE mu.cbs_code = NEW.municipality_code)))), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER museum_search_refresh BEFORE INSERT OR UPDATE OF name, name_en, place, municipality_code, search ON museum
  FOR EACH ROW EXECUTE FUNCTION public.museum_search_refresh();

-- An alias or a municipality name changes the document of other rows. mjk_worker (the sync) and
-- mjk_api (the admin CLI) insert aliases and rename municipalities but hold no grant on
-- museum.search, so these two functions run as their owner mjk_migrator (SECURITY DEFINER) and
-- ask for the recompute by setting search to NULL (the BEFORE trigger above fills it in).
CREATE FUNCTION public.museum_alias_search_touch() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.museum SET search = NULL WHERE id = OLD.museum_id;
  ELSE
    UPDATE public.museum SET search = NULL WHERE id = NEW.museum_id;
    IF TG_OP = 'UPDATE' AND OLD.museum_id IS DISTINCT FROM NEW.museum_id THEN
      UPDATE public.museum SET search = NULL WHERE id = OLD.museum_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.museum_alias_search_touch() FROM PUBLIC;

-- Only a real change fires them: P1a proves that a sync of unchanged input changes no row
-- (ctid, xmin), and an upsert or ON CONFLICT DO NOTHING that changes nothing fires no row trigger.
CREATE TRIGGER museum_alias_search_touch_ins_del AFTER INSERT OR DELETE ON museum_alias
  FOR EACH ROW EXECUTE FUNCTION public.museum_alias_search_touch();
CREATE TRIGGER museum_alias_search_touch_upd AFTER UPDATE OF alias, museum_id ON museum_alias
  FOR EACH ROW WHEN (OLD.alias IS DISTINCT FROM NEW.alias OR OLD.museum_id IS DISTINCT FROM NEW.museum_id)
  EXECUTE FUNCTION public.museum_alias_search_touch();

CREATE FUNCTION public.municipality_search_touch() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.museum SET search = NULL WHERE municipality_code = NEW.cbs_code;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.municipality_search_touch() FROM PUBLIC;

CREATE TRIGGER municipality_search_touch AFTER UPDATE OF name ON municipality
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.municipality_search_touch();

-- updated_at says when a museum's own fields last changed. A recompute of the search document alone
-- (the touch functions above, the backfill below) is not such a change: an update whose only
-- changes are `search` and `updated_at` keeps OLD.updated_at. museum_search_refresh fires first
-- (BEFORE triggers fire in name order), so NEW.search already holds the recomputed document here.
-- P1a's function (20261102000002_museums.sql) is replaced in place; the down section restores it.
CREATE OR REPLACE FUNCTION public.museum_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'search' - 'updated_at') = (to_jsonb(OLD) - 'search' - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill: every existing row is recomputed by the trigger (NULL is replaced before the NOT NULL
-- check); updated_at stays as it was.
UPDATE museum SET search = NULL;

CREATE INDEX museum_search_idx ON museum USING gin (search);
CREATE INDEX museum_name_trgm_idx ON museum USING gin (public.mjk_unaccent(name) gin_trgm_ops);
CREATE INDEX museum_alias_trgm_idx ON museum_alias USING gin (public.mjk_unaccent(alias) gin_trgm_ops);
-- The keyset sort key: the cluster's builtin C.UTF-8 collation sorts by code point, so the key
-- is unaccented and lower-case.
CREATE INDEX museum_sort_idx ON museum (lower(public.mjk_unaccent(name)), id);
CREATE INDEX museum_lat_lon_idx ON museum (lat, lon);

-- A museum's slug changes only through the owner's admin command, and every old slug answers
-- 301 for good. Rows hold the museum id, so a second change leaves no chain.
CREATE TABLE museum_slug_redirect (
  old_slug text PRIMARY KEY CHECK (old_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(old_slug) <= 120),
  museum_id uuid NOT NULL REFERENCES museum (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX museum_slug_redirect_museum_idx ON museum_slug_redirect (museum_id);

-- SECURITY DEFINER (owner mjk_migrator), so no login needs INSERT on museum_slug_redirect: the
-- table is written only here, with the pair the trigger derives from OLD (never a forged one).
-- No parameters, a pinned search_path, every name schema-qualified; EXECUTE is the owner's only.
CREATE FUNCTION public.museum_slug_keep() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.museum_slug_redirect (old_slug, museum_id) VALUES (OLD.slug, OLD.id)
    ON CONFLICT (old_slug) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.museum_slug_keep() FROM PUBLIC;

CREATE TRIGGER museum_slug_keep AFTER UPDATE OF slug ON museum
  FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
  EXECUTE FUNCTION public.museum_slug_keep();

-- A slug that another museum used to have is taken for good. The message is fixed, never the slug.
-- A museum may take back its own old slug.
CREATE FUNCTION public.museum_slug_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.museum_slug_redirect r WHERE r.old_slug = NEW.slug AND r.museum_id <> NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'museum_slug_taken';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER museum_slug_guard BEFORE INSERT OR UPDATE OF slug ON museum
  FOR EACH ROW EXECUTE FUNCTION public.museum_slug_guard();

-- Grants (A§8: each phase grants its own tables). The guard runs as whoever writes a slug
-- (mjk_api, mjk_worker), who read the table; the keep trigger runs as its owner. Nothing for
-- mjk_ssr; no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER for any login.
GRANT SELECT ON museum_slug_redirect TO mjk_api, mjk_worker;

-- migrate:down
DROP TRIGGER museum_slug_guard ON museum;
DROP FUNCTION public.museum_slug_guard();
DROP TRIGGER museum_slug_keep ON museum;
DROP FUNCTION public.museum_slug_keep();
DROP TABLE museum_slug_redirect;
DROP INDEX museum_lat_lon_idx;
DROP INDEX museum_sort_idx;
DROP INDEX museum_alias_trgm_idx;
DROP INDEX museum_name_trgm_idx;
DROP INDEX museum_search_idx;
CREATE OR REPLACE FUNCTION public.museum_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER municipality_search_touch ON municipality;
DROP FUNCTION public.municipality_search_touch();
DROP TRIGGER museum_alias_search_touch_upd ON museum_alias;
DROP TRIGGER museum_alias_search_touch_ins_del ON museum_alias;
DROP FUNCTION public.museum_alias_search_touch();
DROP TRIGGER museum_search_refresh ON museum;
DROP FUNCTION public.museum_search_refresh();
ALTER TABLE museum DROP COLUMN search;
DROP FUNCTION public.mjk_unaccent(text);
