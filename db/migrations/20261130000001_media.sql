-- migrate:up
-- P3b (A§8, A§12, ADR-0018): photos and the Commons image of a museum. The CHECKs match
-- packages/contracts/src/media.ts and apps/server/src/media/limits.ts and are the last line behind the zod
-- schemas. mjk_ssr gets no table here, only pub_media and pub_museum_image (A§8). Nobody gets TRUNCATE,
-- REFERENCES or TRIGGER. Free text uses P3a's rule: no control or bidi characters (ARE escapes, never raw).

-- user_id is ON DELETE RESTRICT, a deliberate difference from A§8's cascade: deleting an account (P3d) must
-- first walk R2 (variants) and the originals in quarantine, which a cascade would orphan. P3d deletes the
-- media rows, then the user.
-- States: uploading -> quarantined -> processing -> pending_review | approved | rejected | failed; removed.
CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  museum_id uuid NOT NULL REFERENCES museum (id),
  review_id uuid REFERENCES review (id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'photo' CHECK (kind = 'photo'),
  type text NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp')),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN (
    'uploading', 'quarantined', 'processing', 'pending_review', 'approved', 'rejected', 'removed', 'failed'
  )),
  -- 25 MiB; 8 MiB chunks, so 1 to 4 of them.
  declared_size integer NOT NULL CHECK (declared_size BETWEEN 1 AND 26214400),
  chunk_count smallint NOT NULL CHECK (chunk_count = (declared_size + 8388607) / 8388608),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  width integer CHECK (width BETWEEN 1 AND 100000),
  height integer CHECK (height BETWEEN 1 AND 100000),
  public_key text UNIQUE CHECK (public_key ~ '^[0-9a-f]{32}$'),
  alt_text text CHECK (
    char_length(alt_text) BETWEEN 1 AND 250
    AND alt_text !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'
  ),
  consents_at timestamptz NOT NULL,
  error_code text CHECK (error_code ~ '^[a-z_]{1,40}$'),
  decided_by uuid REFERENCES app_user (id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_sha256_set CHECK (state IN ('uploading', 'failed', 'removed') OR sha256 IS NOT NULL),
  CONSTRAINT media_published_set CHECK (
    state NOT IN ('pending_review', 'approved')
    OR (width IS NOT NULL AND height IS NOT NULL AND public_key IS NOT NULL)
  )
);
-- updated_at is the trigger's, so no login needs a grant on it.
CREATE FUNCTION media_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER media_set_updated_at BEFORE UPDATE ON media
  FOR EACH ROW EXECUTE FUNCTION media_set_updated_at();

-- A§8 [U P3b], option (a): the indexes a caller's leakproof qual (review_id, museum_id) on pub_media can reach
-- are partial on state = 'approved', so EXPLAIN (ANALYZE) as mjk_ssr never sees a non-approved row there.
-- No other index on review_id or museum_id. The rest serve the server's own queries.
CREATE INDEX media_review_approved_idx ON media (review_id) WHERE state = 'approved';
CREATE INDEX media_museum_approved_idx ON media (museum_id, id) WHERE state = 'approved';
CREATE INDEX media_user_idx ON media (user_id);
CREATE INDEX media_uploading_idx ON media (created_at) WHERE state = 'uploading';
CREATE INDEX media_unattached_idx ON media (created_at) WHERE review_id IS NULL;

CREATE TABLE media_chunk (
  media_id uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  n smallint NOT NULL CHECK (n BETWEEN 0 AND 3),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  PRIMARY KEY (media_id, n)
);

CREATE TABLE media_variant (
  media_id uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format IN ('avif', 'webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2000),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^p/[0-9a-f]{32}/[0-9]{1,4}\.(avif|webp)$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 67108864),
  PRIMARY KEY (media_id, format, width)
);

-- Hashes of removed photos that must never be accepted again. moderation_action_id is a plain column: P3c
-- adds the moderation_action table and the foreign key (expand-only).
CREATE TABLE blocked_hash (
  sha256 bytea PRIMARY KEY CHECK (octet_length(sha256) = 32),
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,40}$'),
  moderation_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The Commons image of a museum (ADR-0018): one row per museum, written by the worker.
CREATE TABLE museum_image (
  museum_id uuid PRIMARY KEY REFERENCES museum (id),
  file text NOT NULL CHECK (char_length(file) BETWEEN 1 AND 255 AND file !~ '[[:cntrl:]#<>\[\]|{}/]'),
  sha1 text CHECK (sha1 ~ '^[0-9a-f]{40}$'),
  licence text CHECK (licence ~ '^(cc0|pd|cc-by(-sa)?-(1\.0|2\.0|2\.5|3\.0|4\.0)(-[a-z]{2})?)$'),
  attribution text CHECK (
    char_length(attribution) BETWEEN 1 AND 200
    AND attribution !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'
  ),
  public_key text UNIQUE CHECK (public_key ~ '^[0-9a-f]{32}$'),
  width integer CHECK (width BETWEEN 1 AND 100000),
  height integer CHECK (height BETWEEN 1 AND 100000),
  widths smallint[] CHECK (
    array_ndims(widths) = 1 AND cardinality(widths) BETWEEN 1 AND 4 AND array_position(widths, NULL) IS NULL
    AND 1 <= ALL (widths) AND 2000 >= ALL (widths)
  ),
  state text NOT NULL CHECK (state IN ('active', 'hidden', 'skipped')),
  skip_code text CHECK (skip_code ~ '^[a-z_]{1,40}$'),
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT museum_image_active_set CHECK (
    state <> 'active'
    OR (sha1 IS NOT NULL AND licence IS NOT NULL AND public_key IS NOT NULL
        AND width IS NOT NULL AND height IS NOT NULL AND widths IS NOT NULL)
  ),
  CONSTRAINT museum_image_skipped_set CHECK (state <> 'skipped' OR skip_code IS NOT NULL)
);

-- Photos follow their review exactly as pub_review does: a visible review of a museum that is not hidden, by
-- an author who is not deleted. A banned author's photo stays, with no handle. Never user_id, sha256, state,
-- error_code, consents_at or a decider. widths: the ascending AVIF widths that exist.
CREATE VIEW pub_media WITH (security_barrier) AS
SELECT
  md.id, md.review_id, md.museum_id,
  CASE WHEN u.status = 'active' THEN u.handle::text END AS author_handle,
  md.width, md.height, md.alt_text, md.public_key,
  ARRAY(SELECT v.width FROM media_variant v WHERE v.media_id = md.id AND v.format = 'avif' ORDER BY v.width) AS widths,
  md.created_at
FROM media md
JOIN review r ON r.id = md.review_id
JOIN museum m ON m.id = md.museum_id
JOIN app_user u ON u.id = md.user_id
WHERE md.state = 'approved'
  AND r.state = 'visible'
  AND NOT m.hidden
  AND u.status <> 'deleted';

CREATE VIEW pub_museum_image WITH (security_barrier) AS
SELECT i.museum_id, i.file, i.licence, i.attribution, i.public_key, i.width, i.height, i.widths
FROM museum_image i
JOIN museum m ON m.id = i.museum_id
WHERE i.state = 'active' AND NOT m.hidden;

-- Grants (A§8: each phase grants its own tables).
-- mjk_api: the upload and moderation paths. A cascade to the chunks and variants runs as their owner.
GRANT SELECT, INSERT, DELETE ON media TO mjk_api;
GRANT UPDATE (state, review_id, alt_text, sha256, error_code) ON media TO mjk_api;
GRANT SELECT, INSERT, DELETE ON media_chunk TO mjk_api;
GRANT SELECT ON media_variant TO mjk_api;
GRANT SELECT ON blocked_hash TO mjk_api;
GRANT SELECT ON museum_image TO mjk_api;
GRANT UPDATE (state) ON museum_image TO mjk_api;
-- The `admin user trust` CLI; P3c's moderators set it through the api.
GRANT UPDATE (trusted_at) ON app_user TO mjk_api;
-- mjk_worker: processing and publishing, the Commons sync.
GRANT SELECT, DELETE ON media TO mjk_worker;
GRANT UPDATE (state, width, height, public_key, error_code, decided_at) ON media TO mjk_worker;
GRANT SELECT, INSERT, DELETE ON media_variant TO mjk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON museum_image TO mjk_worker;
GRANT SELECT (trusted_at) ON app_user TO mjk_worker;
GRANT SELECT ON pub_media, pub_museum_image TO mjk_api, mjk_ssr;

-- migrate:down
REVOKE SELECT (trusted_at) ON app_user FROM mjk_worker;
REVOKE UPDATE (trusted_at) ON app_user FROM mjk_api;
DROP VIEW pub_museum_image;
DROP VIEW pub_media;
DROP TABLE museum_image;
DROP TABLE blocked_hash;
DROP TABLE media_variant;
DROP TABLE media_chunk;
DROP TABLE media;
DROP FUNCTION media_set_updated_at();
