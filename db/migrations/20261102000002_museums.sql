-- migrate:up
-- P1a (A§7.2, A§7.4, A§7.5, A§8): the museum catalogue, its sources, its change
-- log and the frozen Museumkaart list. The CHECK lists below are the ones in
-- apps/server/src/museums/fields.ts; grants.int.test.ts compares them.

CREATE TABLE museum (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 120),
  wikidata_qid text UNIQUE CHECK (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  rce_id text UNIQUE CHECK (rce_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 250),
  name_en text CHECK (char_length(name_en) BETWEEN 1 AND 250),
  description_nl text CHECK (char_length(description_nl) BETWEEN 1 AND 250),
  description_en text CHECK (char_length(description_en) BETWEEN 1 AND 250),
  lat double precision,
  lon double precision,
  website text CHECK (website ~ '^https://' AND website !~ '[[:space:]]' AND char_length(website) <= 2048),
  street text CHECK (char_length(street) BETWEEN 1 AND 200),
  house_number text CHECK (char_length(house_number) BETWEEN 1 AND 20),
  postcode text CHECK (postcode ~ '^[1-9][0-9]{3} [A-Z]{2}$'),
  place text CHECK (char_length(place) BETWEEN 1 AND 100),
  municipality_code text REFERENCES municipality (cbs_code),
  registered boolean NOT NULL DEFAULT false,
  -- The one museum.nl string in a migration: a link, never copied text (CLAUDE.md data rules).
  museumnl_url text CHECK (
    museumnl_url ~ '^https://www\.museum\.nl/' AND museumnl_url !~ '[[:space:]]' AND char_length(museumnl_url) <= 2048
  ),
  categories text[] NOT NULL DEFAULT '{}'
    CHECK (categories <@ ARRAY['art', 'history', 'natural_history', 'science_technology', 'ethnology', 'other']::text[]),
  closed_on date,
  -- The Commons file name of P18 without the `File:` prefix (plan §2.9).
  commons_file text CHECK (char_length(commons_file) BETWEEN 1 AND 255 AND commons_file !~ '[[:cntrl:]#<>\[\]|{}/]'),
  -- Curated by the owner only (A§7.5): the sync's login has no grant on these.
  museumkaart_status text NOT NULL DEFAULT 'unknown' CHECK (museumkaart_status IN ('participating', 'left', 'unknown')),
  mk_since date,
  mk_until date,
  mk_last_verified_at timestamptz,
  admission_adult_cents integer CHECK (admission_adult_cents BETWEEN 0 AND 20000),
  price_verified_at timestamptz,
  photo_policy text NOT NULL DEFAULT 'unknown' CHECK (photo_policy IN ('allowed', 'no_flash', 'forbidden', 'unknown')),
  temp_closed boolean NOT NULL DEFAULT false,
  temp_closed_until date,
  hidden boolean NOT NULL DEFAULT false,
  -- Fields the owner has overridden: the sync never writes them.
  pinned_fields text[] NOT NULL DEFAULT '{}' CHECK (
    pinned_fields <@ ARRAY[
      'wikidata_qid', 'rce_id', 'name', 'name_en', 'description_nl', 'description_en', 'lat', 'lon', 'website',
      'street', 'house_number', 'postcode', 'place', 'municipality_code', 'registered', 'museumnl_url',
      'categories', 'closed_on', 'commons_file'
    ]::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT museum_coordinates_check CHECK (
    (lat IS NULL) = (lon IS NULL)
    AND (lat IS NULL OR (lat BETWEEN 50.7 AND 53.7 AND lon BETWEEN 3.2 AND 7.3))
  ),
  CONSTRAINT museum_mk_period_check CHECK (mk_until IS NULL OR mk_since IS NULL OR mk_until >= mk_since),
  CONSTRAINT museum_mk_left_check CHECK (museumkaart_status <> 'left' OR mk_until IS NOT NULL),
  CONSTRAINT museum_temp_closed_check CHECK (temp_closed_until IS NULL OR temp_closed)
);

CREATE INDEX museum_postcode_idx ON museum (postcode);

-- updated_at is the trigger's, so no login needs a grant on it.
CREATE FUNCTION museum_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER museum_set_updated_at BEFORE UPDATE ON museum
  FOR EACH ROW EXECUTE FUNCTION museum_set_updated_at();

CREATE TABLE museum_alias (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  museum_id uuid NOT NULL REFERENCES museum (id),
  alias text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 250),
  source text NOT NULL CHECK (source IN ('wikidata', 'import', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (museum_id, alias)
);

CREATE TABLE museum_sync_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('seed', 'sync')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  wikidata_rows integer CHECK (wikidata_rows >= 0),
  rce_rows integer CHECK (rce_rows >= 0),
  counts jsonb NOT NULL DEFAULT '{}',
  outcome text CHECK (outcome IN ('applied', 'refused', 'failed')),
  code text CHECK (code ~ '^[a-z_]{1,40}$'),
  accept_drop text CHECK (accept_drop IN ('wikidata', 'rce'))
);

CREATE TABLE museum_source_row (
  source text NOT NULL CHECK (source IN ('wikidata', 'rce')),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 64),
  payload jsonb NOT NULL,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- The run that first saw or last changed the row: there is no per-run "last seen" write.
  run_id bigint NOT NULL REFERENCES museum_sync_run (id),
  matched_museum_id uuid REFERENCES museum (id),
  match_state text NOT NULL CHECK (match_state IN ('matched', 'new', 'ambiguous', 'ignored')),
  match_rule text CHECK (match_rule IN ('id', 'postcode_name', 'distance_name', 'admin')),
  match_reason text CHECK (
    match_reason IN ('no_candidate', 'ambiguous', 'qid_conflict', 'qid_link', 'duplicate', 'dissolved')
  ),
  candidate_ids uuid[] NOT NULL DEFAULT '{}',
  gone_since_run_id bigint REFERENCES museum_sync_run (id),
  PRIMARY KEY (source, external_id),
  CONSTRAINT museum_source_row_matched_check CHECK ((match_state = 'matched') = (matched_museum_id IS NOT NULL))
);

CREATE INDEX museum_source_row_museum_idx ON museum_source_row (matched_museum_id);
CREATE INDEX museum_source_row_open_idx ON museum_source_row (source, external_id)
  WHERE match_state IN ('new', 'ambiguous');

CREATE TABLE museum_change (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  museum_id uuid REFERENCES museum (id),
  field text NOT NULL CHECK (
    field IN (
      'wikidata_qid', 'rce_id', 'name', 'name_en', 'description_nl', 'description_en', 'lat', 'lon', 'website',
      'street', 'house_number', 'postcode', 'place', 'municipality_code', 'registered', 'museumnl_url',
      'categories', 'closed_on', 'commons_file',
      'museumkaart_status', 'mk_since', 'mk_until', 'mk_last_verified_at', 'admission_adult_cents',
      'price_verified_at', 'photo_policy', 'temp_closed', 'temp_closed_until', 'hidden', 'pinned_fields',
      'new_museum', 'presence', 'qid_link', 'coordinates'
    )
  ),
  old jsonb,
  new jsonb,
  origin text NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync', 'admin', 'report')),
  source text CHECK (source IN ('wikidata', 'rce')),
  external_id text,
  run_id bigint REFERENCES museum_sync_run (id),
  state text NOT NULL CHECK (state IN ('applied', 'pending', 'rejected', 'superseded')),
  -- Plain uuids now: app_user arrives in P2a, which adds the foreign keys (NOT VALID, then VALIDATE).
  reporter_id uuid,
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  FOREIGN KEY (source, external_id) REFERENCES museum_source_row (source, external_id),
  CONSTRAINT museum_change_pending_check CHECK (state <> 'pending' OR museum_id IS NOT NULL)
);

-- One open proposal per museum, field and source.
CREATE UNIQUE INDEX museum_change_pending_idx ON museum_change (museum_id, field, source) NULLS NOT DISTINCT
  WHERE state = 'pending';

CREATE TABLE mk_list_version (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  published_on date NOT NULL UNIQUE,
  published_by uuid, -- P2a adds the foreign key to app_user
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mk_list_member (
  list_version_id uuid NOT NULL REFERENCES mk_list_version (id),
  museum_id uuid NOT NULL REFERENCES museum (id),
  PRIMARY KEY (list_version_id, museum_id)
);

-- N is never stored (A§7.5): the count of the newest version's members. No version, no row.
CREATE VIEW mk_list AS
SELECT v.id AS list_version_id, v.published_on, count(m.museum_id) AS n
FROM (SELECT id, published_on FROM mk_list_version ORDER BY published_on DESC LIMIT 1) v
LEFT JOIN mk_list_member m ON m.list_version_id = v.id
GROUP BY v.id, v.published_on;

-- Grants (A§8: each phase grants its own tables). No login gets DELETE, TRUNCATE, REFERENCES or TRIGGER,
-- so nothing is ever hard-deleted and a published list stays frozen. Identity columns need no sequence grant.
GRANT SELECT ON museum, museum_alias, museum_sync_run, museum_source_row, museum_change, mk_list_version,
  mk_list_member, mk_list TO mjk_worker, mjk_api;

-- mjk_worker (the weekly sync): source-fed columns only, so it cannot touch the curated ones.
GRANT INSERT (
  slug, wikidata_qid, rce_id, name, name_en, description_nl, description_en, lat, lon, website, street,
  house_number, postcode, place, municipality_code, registered, museumnl_url, categories, commons_file
) ON museum TO mjk_worker;
GRANT UPDATE (
  rce_id, name_en, description_nl, description_en, lat, lon, website, street, house_number, postcode, place,
  municipality_code, registered, museumnl_url
) ON museum TO mjk_worker;
GRANT INSERT ON museum_alias TO mjk_worker;
GRANT INSERT, UPDATE ON museum_sync_run, museum_source_row TO mjk_worker;
-- Not origin, reporter_id or decided_by: a worker row always has origin 'sync'. Not id or created_at:
-- the defaults set them.
GRANT INSERT (museum_id, field, old, new, source, external_id, run_id, state, decided_at) ON museum_change TO mjk_worker;
GRANT UPDATE (state, decided_at) ON museum_change TO mjk_worker;

-- mjk_api (the admin CLI now, P3c's routes later).
GRANT INSERT (
  slug, wikidata_qid, rce_id, name, name_en, description_nl, description_en, lat, lon, website, street,
  house_number, postcode, place, municipality_code, registered, museumnl_url, categories, closed_on,
  commons_file, museumkaart_status, mk_since, mk_until, mk_last_verified_at, admission_adult_cents,
  price_verified_at, photo_policy, temp_closed, temp_closed_until, hidden, pinned_fields
) ON museum TO mjk_api;
GRANT UPDATE (
  slug, wikidata_qid, rce_id, name, name_en, description_nl, description_en, lat, lon, website, street,
  house_number, postcode, place, municipality_code, registered, museumnl_url, categories, closed_on,
  commons_file, museumkaart_status, mk_since, mk_until, mk_last_verified_at, admission_adult_cents,
  price_verified_at, photo_policy, temp_closed, temp_closed_until, hidden, pinned_fields
) ON museum TO mjk_api;
GRANT INSERT ON museum_alias TO mjk_api;
GRANT UPDATE (matched_museum_id, match_state, match_rule, match_reason, candidate_ids)
  ON museum_source_row TO mjk_api;
GRANT INSERT ON museum_change TO mjk_api;
GRANT UPDATE (state, decided_by, decided_at) ON museum_change TO mjk_api;
GRANT INSERT ON mk_list_version, mk_list_member TO mjk_api;

-- migrate:down
DROP VIEW mk_list;
DROP TABLE mk_list_member;
DROP TABLE mk_list_version;
DROP TABLE museum_change;
DROP TABLE museum_source_row;
DROP TABLE museum_sync_run;
DROP TABLE museum_alias;
DROP TABLE museum;
DROP FUNCTION museum_set_updated_at();
