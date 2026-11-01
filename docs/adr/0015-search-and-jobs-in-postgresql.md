# ADR-0015: Search and jobs in PostgreSQL

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The catalogue holds ~1,400 museums. Search must handle Dutch names, accents and typos, with filters and "near me" on top (A§14).
- Background work: photo processing, R2 uploads, email, the weekly museum sync, the quarterly basemap refresh, stats and ranking, account deletion, export bundles and retention purges (A§5).
- Principle: add no service where a table will do (A§2). A planning choice without a D-number (A§3).
- Research, 2026-11-01 (`docs/plan/research/media.md`): pg-boss 12.38.0 brings 22 transitive dependencies and graphile-worker 0.18.0 brings 67 (deps.dev); Kysely supports `FOR UPDATE SKIP LOCKED`.

## Decision

- **Search:** PostgreSQL full-text search with `unaccent` and the `dutch` configuration, through an immutable `unaccent` wrapper (A§8), plus `pg_trgm` for fuzzy names. Trusted extensions only: `pg_trgm`, `unaccent`, `citext`.
- **Near me:** a bounding box, then haversine in SQL on `lat`/`lon`; no PostGIS.
- **Filters:** province, municipality, category, Museumkaart, visited or not and wishlist (logged in), minimum rating, kid-friendly.
- **Jobs:** our own `job` table (A§8) with `FOR UPDATE SKIP LOCKED` and `LISTEN/NOTIFY`, no library. Payloads hold ids only, with one exception: `mail_code`, `mail_invite` and the two account-notice mails add a sealed code and/or recipient address (AES-256-GCM under the `code_seal` key in `app_keys`), nulled once sent, a code also at `expires_at` (A§9). Attempts, `run_at` backoff and a fixed error code; finished rows are deleted after 30 days, mail jobs on success. Schedules use croner with F1's busy guard. Photo jobs run one at a time.
- **Rate limits** live in PostgreSQL too (`rate_limit`, A§9).

## Consequences

- No extra container, backup or dependency.
- We own the retry and backoff code; integration tests on real PostgreSQL 18 cover locking and retries (A§18).
- Typo tolerance across words is limited [U]; it is tuned in P1b and is enough for ~1,400 rows.
- One database carries the queue's writes, which are small at this scale [U].

## Alternatives rejected

- **Elasticsearch or Meilisearch:** an extra service, its memory and its own index for 1,400 rows.
- **PostGIS:** overkill for points and a radius on ~1,400 rows.
- **pg-boss 12.38 or graphile-worker 0.18:** 22 and 67 transitive dependencies, and their own schemas, for a small queue.
