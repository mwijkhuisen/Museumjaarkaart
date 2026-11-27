-- migrate:up
-- P3a (A§8, A§10, A§13; D13, D17, ADR-0017): ratings and reviews. One review per member per museum, citing
-- one of the member's own visits; private revisions of every edit; the scores per museum that the worker
-- keeps (museum_stats); what the public may see of them. The CHECKs match packages/contracts/src/reviews.ts
-- and are the last line behind the zod schemas. mjk_ssr gets no table here, only pub_museum_stats and three
-- SECURITY DEFINER functions (A§8). Nobody gets TRUNCATE, REFERENCES or TRIGGER.

-- A review cites a visit of the same member to the same museum: the composite foreign key below needs a
-- unique key over exactly those three columns.
ALTER TABLE visit ADD CONSTRAINT visit_owner_key UNIQUE (id, user_id, museum_id);

-- user_id is null only after D10's detach (P3d): the review then stays under "a former member" with the visit
-- date copied to former_visited_on and the visit link cut (visit_id null). The three detach CHECKs say so.
-- The body is plain text: 1 to 5,000 code points (char_length counts code points, like [...s].length in the
-- contract) and none of the control or bidi characters that normaliseReviewBody rejects: U+0001-U+0009,
-- U+000B-U+001F (a newline, U+000A, is allowed), U+007F-U+009F, U+2028, U+2029, U+202A-U+202E and
-- U+2066-U+2069, written as ARE escapes (backslash, u and four hex digits) in the literal, never as raw characters.
CREATE TABLE review (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid REFERENCES app_user (id) ON DELETE CASCADE,
  museum_id uuid NOT NULL REFERENCES museum (id),
  visit_id uuid,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  collection smallint CHECK (collection BETWEEN 1 AND 5),
  presentation smallint CHECK (presentation BETWEEN 1 AND 5),
  kid_friendly smallint CHECK (kid_friendly BETWEEN 1 AND 5),
  accessibility smallint CHECK (accessibility BETWEEN 1 AND 5),
  facilities smallint CHECK (facilities BETWEEN 1 AND 5),
  value_for_money smallint CHECK (value_for_money BETWEEN 1 AND 5),
  body text CHECK (
    char_length(body) BETWEEN 1 AND 5000
    AND body !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'
  ),
  state text NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'removed')),
  former_member boolean NOT NULL DEFAULT false,
  former_visited_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  CONSTRAINT review_once UNIQUE (user_id, museum_id),
  -- MATCH SIMPLE (the default): a detached row (user_id and visit_id null) is not checked.
  -- The [U] of A§8, proven in apps/server/test/reviews/schema.int.test.ts: see "The RESTRICT question" below.
  CONSTRAINT review_cites_own_visit FOREIGN KEY (visit_id, user_id, museum_id)
    REFERENCES visit (id, user_id, museum_id) ON DELETE RESTRICT,
  CONSTRAINT review_detached_user CHECK (former_member = (user_id IS NULL)),
  CONSTRAINT review_detached_visit CHECK ((visit_id IS NULL) = former_member),
  CONSTRAINT review_detached_date CHECK (former_member OR former_visited_on IS NULL)
);
CREATE INDEX review_museum_idx ON review (museum_id, id DESC);
CREATE INDEX review_user_idx ON review (user_id, id DESC);
CREATE INDEX review_visit_idx ON review (visit_id);

-- The RESTRICT question: deleting an app_user cascades to visit and to review, and review_cites_own_visit
-- points from review to visit. Proven with PostgreSQL 18.6 (schema.int.test.ts): ON DELETE RESTRICT does not
-- block the account delete (the same in a plain model of the three tables). Reason, as read from the
-- behaviour: the after-trigger events that the cascades raise go on one queue, so the RESTRICT check of the
-- cascaded visit delete runs behind the cascade that deletes the review and finds no review left; NO ACTION
-- is not needed. A direct DELETE FROM visit of a cited visit raises at the statement itself (RESTRICT cannot
-- be deferred), SQLSTATE 23001 (restrict_violation; NO ACTION would give 23503), constraint
-- review_cites_own_visit, table review.

-- What an edit replaced: the previous rating, aspects and body, private to the member and the moderators.
CREATE TABLE review_revision (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  review_id uuid NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  collection smallint CHECK (collection BETWEEN 1 AND 5),
  presentation smallint CHECK (presentation BETWEEN 1 AND 5),
  kid_friendly smallint CHECK (kid_friendly BETWEEN 1 AND 5),
  accessibility smallint CHECK (accessibility BETWEEN 1 AND 5),
  facilities smallint CHECK (facilities BETWEEN 1 AND 5),
  value_for_money smallint CHECK (value_for_money BETWEEN 1 AND 5),
  body text CHECK (
    char_length(body) BETWEEN 1 AND 5000
    AND body !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_revision_review_idx ON review_revision (review_id, id);

-- The scores per museum, written only by the worker's stats_recompute job. Every mean is round(avg, 1), the one
-- shown value that the filters, the UI and the JSON-LD all use; bayes_score is unrounded. float8 and not
-- numeric: float8 comparisons are leakproof, so the list's filters reach below the barrier of
-- pub_museum_stats, and pg returns a number. rating_mean is null when the count is 0.
CREATE TABLE museum_stats (
  museum_id uuid PRIMARY KEY REFERENCES museum (id),
  rating_count integer NOT NULL CHECK (rating_count >= 0),
  rating_mean float8 CHECK (rating_mean BETWEEN 1 AND 5),
  bayes_score float8 NOT NULL,
  collection_count integer NOT NULL CHECK (collection_count >= 0),
  collection_mean float8 CHECK (collection_mean BETWEEN 1 AND 5),
  presentation_count integer NOT NULL CHECK (presentation_count >= 0),
  presentation_mean float8 CHECK (presentation_mean BETWEEN 1 AND 5),
  kid_friendly_count integer NOT NULL CHECK (kid_friendly_count >= 0),
  kid_friendly_mean float8 CHECK (kid_friendly_mean BETWEEN 1 AND 5),
  accessibility_count integer NOT NULL CHECK (accessibility_count >= 0),
  accessibility_mean float8 CHECK (accessibility_mean BETWEEN 1 AND 5),
  facilities_count integer NOT NULL CHECK (facilities_count >= 0),
  facilities_mean float8 CHECK (facilities_mean BETWEEN 1 AND 5),
  value_for_money_count integer NOT NULL CHECK (value_for_money_count >= 0),
  value_for_money_mean float8 CHECK (value_for_money_mean BETWEEN 1 AND 5),
  visit_count integer NOT NULL CHECK (visit_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((rating_count = 0) = (rating_mean IS NULL))
);

-- The public scores: not visit_count (Q8, owner: it appears in no public view) and not updated_at; hidden
-- museums excluded.
CREATE VIEW pub_museum_stats WITH (security_barrier) AS
SELECT
  s.museum_id,
  s.rating_count, s.rating_mean, s.bayes_score,
  s.collection_count, s.collection_mean,
  s.presentation_count, s.presentation_mean,
  s.kid_friendly_count, s.kid_friendly_mean,
  s.accessibility_count, s.accessibility_mean,
  s.facilities_count, s.facilities_mean,
  s.value_for_money_count, s.value_for_money_mean
FROM museum_stats s
JOIN museum m ON m.id = s.museum_id
WHERE NOT m.hidden;

-- The public reviews: three functions with the same columns, the pub_visit_log pattern exactly.
-- Why functions and not a view: "Bezocht op" joins visit, and a barrier view would let a compromised mjk_ssr
-- run EXPLAIN (ANALYZE) and count private visits per date ("Rows Removed by Filter" of a leakproof date qual
-- that reaches the visit scan). A SECURITY DEFINER function with SET is never inlined and is opaque to EXPLAIN.
-- It also settles A§8's [U P3a] about removed reviews: state is only ever read inside the body.
-- Same safety argument as pub_search: static SQL (no EXECUTE, no format()), the parameters only as $n, every
-- name schema-qualified, the search_path pinned; the plain operators resolve to pg_catalog's.
-- Rows: visible reviews of museums that are not hidden, by authors who are not deleted (a detached review,
-- user_id null, stays). A banned author's review stays with author_active = false and no handle, so the page
-- does not link a profile that does not exist. Never the user id, the visit id, the state or a revision.
-- Newest first by id (uuidv7); $2 null means from the newest, else the rows before it; at most 51 rows, so
-- the caller reads one more than a page of 50 to know whether there is a next one.
CREATE FUNCTION public.pub_review(p_id uuid)
RETURNS TABLE (
  id uuid, museum_id uuid, museum_slug text, museum_name text, museum_name_en text,
  author_handle text, author_display_name text, author_active boolean, former_member boolean,
  visited_on date, rating smallint,
  collection smallint, presentation smallint, kid_friendly smallint,
  accessibility smallint, facilities smallint, value_for_money smallint,
  body text, created_at timestamptz, edited_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
SELECT r.id, r.museum_id, m.slug, m.name, m.name_en,
       CASE WHEN u.status = 'active' THEN u.handle::text END,
       CASE WHEN NOT r.former_member THEN u.display_name END,
       COALESCE(u.status = 'active', false),
       r.former_member,
       COALESCE(v.visited_on, r.former_visited_on),
       r.rating, r.collection, r.presentation, r.kid_friendly, r.accessibility, r.facilities, r.value_for_money,
       r.body, r.created_at, r.edited_at
  FROM public.review r
  JOIN public.museum m ON m.id = r.museum_id
  LEFT JOIN public.app_user u ON u.id = r.user_id
  LEFT JOIN public.visit v ON v.id = r.visit_id
 WHERE r.id = $1
   AND r.state = 'visible'
   AND NOT m.hidden
   AND u.status IS DISTINCT FROM 'deleted'
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_review(uuid) TO mjk_api, mjk_ssr;

CREATE FUNCTION public.pub_reviews_of_museum(p_museum_id uuid, p_before uuid, p_limit integer)
RETURNS TABLE (
  id uuid, museum_id uuid, museum_slug text, museum_name text, museum_name_en text,
  author_handle text, author_display_name text, author_active boolean, former_member boolean,
  visited_on date, rating smallint,
  collection smallint, presentation smallint, kid_friendly smallint,
  accessibility smallint, facilities smallint, value_for_money smallint,
  body text, created_at timestamptz, edited_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
SELECT r.id, r.museum_id, m.slug, m.name, m.name_en,
       CASE WHEN u.status = 'active' THEN u.handle::text END,
       CASE WHEN NOT r.former_member THEN u.display_name END,
       COALESCE(u.status = 'active', false),
       r.former_member,
       COALESCE(v.visited_on, r.former_visited_on),
       r.rating, r.collection, r.presentation, r.kid_friendly, r.accessibility, r.facilities, r.value_for_money,
       r.body, r.created_at, r.edited_at
  FROM public.review r
  JOIN public.museum m ON m.id = r.museum_id
  LEFT JOIN public.app_user u ON u.id = r.user_id
  LEFT JOIN public.visit v ON v.id = r.visit_id
 WHERE r.museum_id = $1
   AND ($2 IS NULL OR r.id < $2)
   AND r.state = 'visible'
   AND NOT m.hidden
   AND u.status IS DISTINCT FROM 'deleted'
 ORDER BY r.id DESC
 LIMIT least(greatest($3, 1), 51)
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_reviews_of_museum(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_reviews_of_museum(uuid, uuid, integer) TO mjk_api, mjk_ssr;

-- A member's reviews: active members only (the match is on text, as in pub_visit_log: handles are stored
-- lower-case, the api checks HANDLE_RE first, and = on citext would need OPERATOR(public.=) under the pinned
-- path). A banned, a deleted and an unknown handle all give the same empty result.
CREATE FUNCTION public.pub_reviews_of_user(p_handle text, p_before uuid, p_limit integer)
RETURNS TABLE (
  id uuid, museum_id uuid, museum_slug text, museum_name text, museum_name_en text,
  author_handle text, author_display_name text, author_active boolean, former_member boolean,
  visited_on date, rating smallint,
  collection smallint, presentation smallint, kid_friendly smallint,
  accessibility smallint, facilities smallint, value_for_money smallint,
  body text, created_at timestamptz, edited_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
SELECT r.id, r.museum_id, m.slug, m.name, m.name_en,
       u.handle::text,
       u.display_name,
       true,
       r.former_member,
       COALESCE(v.visited_on, r.former_visited_on),
       r.rating, r.collection, r.presentation, r.kid_friendly, r.accessibility, r.facilities, r.value_for_money,
       r.body, r.created_at, r.edited_at
  FROM public.app_user u
  JOIN public.review r ON r.user_id = u.id
  JOIN public.museum m ON m.id = r.museum_id
  LEFT JOIN public.visit v ON v.id = r.visit_id
 WHERE u.handle::text = $1
   AND u.status = 'active'
   AND ($2 IS NULL OR r.id < $2)
   AND r.state = 'visible'
   AND NOT m.hidden
 ORDER BY r.id DESC
 LIMIT least(greatest($3, 1), 51)
$body$;
REVOKE EXECUTE ON FUNCTION public.pub_reviews_of_user(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pub_reviews_of_user(text, uuid, integer) TO mjk_api, mjk_ssr;

-- At most one stats_recompute job is queued at a time: the writers' INSERT ... ON CONFLICT DO NOTHING
-- (apps/server/src/reviews/stats-queue.ts) conflicts with this index; a running job does not.
CREATE UNIQUE INDEX job_stats_queued_idx ON job (kind) WHERE kind = 'stats_recompute' AND state = 'queued';

-- Grants (A§8: each phase grants its own tables).
-- mjk_api: a member edits the visit it cites, the rating, the aspects, the body and the edit time of a review,
-- never user_id, museum_id, state or the detach columns. A revision is only ever written. The scores are read
-- through the barrier view; the api cannot read or write museum_stats itself.
GRANT SELECT, INSERT, DELETE ON review TO mjk_api;
GRANT UPDATE (visit_id, rating, collection, presentation, kid_friendly, accessibility, facilities,
  value_for_money, body, edited_at) ON review TO mjk_api;
GRANT INSERT ON review_revision TO mjk_api;
GRANT SELECT ON pub_museum_stats TO mjk_api, mjk_ssr;
-- mjk_worker: the stats job reads the reviews (museum, visit and app_user.status it can read already) and
-- writes the scores; the export job reads the revisions.
GRANT SELECT ON review, review_revision TO mjk_worker;
GRANT SELECT, INSERT, UPDATE ON museum_stats TO mjk_worker;

-- migrate:down
DROP INDEX job_stats_queued_idx;
DROP FUNCTION public.pub_reviews_of_user(text, uuid, integer);
DROP FUNCTION public.pub_reviews_of_museum(uuid, uuid, integer);
DROP FUNCTION public.pub_review(uuid);
DROP VIEW pub_museum_stats;
DROP TABLE museum_stats;
DROP TABLE review_revision;
DROP TABLE review;
ALTER TABLE visit DROP CONSTRAINT visit_owner_key;
