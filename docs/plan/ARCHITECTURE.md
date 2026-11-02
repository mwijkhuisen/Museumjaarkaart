# Architecture: Museumjaarkaart (code name mjk)

Status: draft for the owner's approval (2026-11-01). Cited as A§x. Decisions are recorded in `docs/adr/`; this file is the overview. Facts marked **[U]** are unverified and are checked by the first phase that depends on them.

## 1. Product

- **What:** a public NL/EN website about Dutch museums: a catalogue of all ~1,360 museums in the Netherlands with search, filters and a map (A§7, A§15.3); a personal **museum passport** (visit log, progress against the Museumkaart list "37 van 512 · lijst nov 2026", wishlist, € saved with the card; A§10); ratings and reviews tied to a logged visit, with photos (A§11, A§12); public profiles. Later: helpful votes and comments, follows, a feed (P6), and video if beta users ask for it (P7).
- **Who:** anyone can browse. Sign-up is invite-only during the beta (D1) and opens in P5a. The audience is Museumkaart holders (1.54M cards, 9.7M visits in 2025 [U]) and museum-goers. Expect a niche: the closest trackers have tiny use (MuseoTrack ~85 monthly users, Cultra ~50 installs [U]).
- **The gap** (prior art, 2026-11-01): passports exist only as private, mostly iOS apps, and public reviews live on Google and Tripadvisor, which know nothing about the card. Nothing combines a web-first public passport with reviews by card holders tied to their visits (ADR-0001). Risks: A§20.
- **Brand:** not chosen (D5, owner action A1). The brand and domain never contain "Museum(jaar)kaart". Shortlist: Muselog / Muzelog, Museumvink, Museumlog. Museumlog has a high conflict: museumlog.app is "Museum Log", an international, English-language, pre-launch visit-logbook app (registered 2026-05-04), not a Dutch one.
  - Code reads the brand from config (`MJK_BRAND_NAME`, `MJK_DOMAIN`) and the i18n messages. The plan writes `<brand>` and `<domain>`. The code name `mjk` (D23) is never shown to visitors.
  - "Museumkaart geldig" appears only as a description. The footer says the site is not affiliated with the Museumvereniging or the Museumkaart (ADR-0006).
- **Non-goals:** selling, renewing or showing the card; tickets; opening hours or an exhibitions agenda (we link to museum.nl and the museum's own site) · a native app (a PWA instead, P5a) · ads, affiliate links, donations or any other revenue (D14) · OpenStreetMap data in our database (only inside the basemap tiles) and Google data of any kind · scraping or copying museum.nl · social login (D8) · museum accounts or a right of reply in v1 (revisit after the beta).

## 2. Principles

1. **Small and boring.** One VM and one server image with roles. PostgreSQL does search, jobs and rate limits too. Add no service where a table will do (ADR-0002, ADR-0015).
2. **Isolated from Waterheight and F1.** Its own compose project, database, tunnel, networks, nftables table, secrets, GIDs, UID, subnets and timers. Nothing in `mjk` can break `rws` or `f1`, and nothing touches their paths (ADR-0003).
3. **Passport first.** The beta ships the catalogue, passport, wishlist, reviews, photos and profiles; the social layer comes after it (D18). Where the official side does something well (the card, the agenda), we link to it.
4. **Honest data.** Unknown stays unknown: `—` with the reason behind it. N names its source and list date. € saved names the museums without a price. Visits are self-declared, and the site says so.
5. **Privacy first.** No trackers, analytics, ads or third-party scripts and fonts. The browser talks only to `<domain>` and our own `media.<domain>`, and a Playwright test enforces it. One strictly necessary cookie. Photo metadata is stripped. Logs hold fixed codes, not people.
6. **Users' content is theirs.** Export at any time, deletion with a choice (D10), an upload licence that ends on deletion, and no sale or licensing of anything to third parties.
7. **Legal by design.** DSA notice and action, statements of reasons, the GDPR rights flows and the retention table are features with tests. They are built in M3, before the beta (ADR-0010).
8. **Never call external services from CI.** Wikidata, RCE, Lettermint, R2 and Cloudflare are recorded fixtures or stand-ins in tests. `record-fixture` refuses to run under `CI`.

## 3. Decisions

All made by the owner on 2026-11-01 (`docs/plan/planning-prompt.md` lists the interview).

| # | Decision | Reason | ADR |
|---|---|---|---|
| D1 | Public browsing; invite-only sign-up beta first, open sign-up later (P5a) | Abuse and moderation stay small while the owner moderates alone | [0001](../adr/0001-product-scope-passport-first.md) |
| D2 | NL and EN via Paraglide, NL default at `/`, EN under `/en/`; reviews in any language | Dutch audience plus expats and visitors; Waterheight's proven set-up | [0013](../adr/0013-dutch-and-english-with-paraglide.md) |
| D3 | Passport with progress, wishlist, map + search + filters (self-hosted), social (votes, comments, follows, feed), all phased | Passport and reviews are the gap; discovery beats the official finder | [0001](../adr/0001-product-scope-passport-first.md), [0014](../adr/0014-self-hosted-basemap-tiles-on-r2.md) |
| D4 | F1-style plan, ADRs, CLAUDE.md, issue and PR templates; one issue per phase, labels, milestones, a Roadmap epic with sub-issues | Same agents and workflow as F1 | PHASES §2 |
| D5 | Neutral brand and domain; owner picks from the shortlist after a trademark check (A1) | "Museumkaart" is a protected name | [0006](../adr/0006-neutral-brand-and-code-name.md) |
| D6 | All NL museums from Wikidata + RCE, weekly sync; curated Museumkaart flag (owner + moderated reports); no museum.nl scraping; ask the Museumvereniging for a feed (A5); no OSM | CC0 and public domain are reusable; museum.nl terms and database right; ODbL is share-alike | [0005](../adr/0005-museum-data-from-wikidata-and-rce.md) |
| D7 | Photos at launch, video later; chunked uploads through our API; processing on the VM; derivatives on R2 (EU) at `media.<domain>`; originals at home + off-site | Tunnel 100 MB body cap; Cloudflare's terms want large files on R2; the browser stays first-party | [0008](../adr/0008-media-through-the-api-served-from-r2.md) |
| D8 | Email code, passkeys, email + password (argon2id in `node:crypto`); no Google/Apple; own auth code, not better-auth | No third-party scripts; few dependencies; better-auth's release churn and advisories | [0007](../adr/0007-own-authentication.md) |
| D9 | Text live at once; photos (later videos) of untrusted accounts queued; owner moderates alone, a moderator role exists; report button and statement of reasons everywhere | DSA Art. 16/17; photos carry the copyright and portrait risk | [0010](../adr/0010-moderation-and-legal-by-design.md) |
| D10 | At deletion the user chooses: delete everything, or keep reviews (without photos) as "voormalig lid" | Erasure, with a way to keep useful reviews (A§13.5) | [0010](../adr/0010-moderation-and-legal-by-design.md) |
| D11 | Same Hyper-V VM as Waterheight and F1; a third compose project with its own Postgres, tunnel, networks, nftables table and IDs | The hardware exists; F1 proved the isolation pattern | [0003](../adr/0003-own-compose-project-on-the-shared-vm.md) |
| D12 | Public profile with a display name; reviews and photos public; visit log and wishlist private unless the user makes them public (or, from P6b, shares them with followers) | Privacy by default (GDPR Art. 25) | [0001](../adr/0001-product-scope-passport-first.md) |
| D13 | Overall 1–5 stars (drives the average) + optional aspect scores; one review per member per museum, editable, linked to a visit | Comparable scores; aspects answer "with kids?" and "accessible?" | [0017](../adr/0017-visit-tied-reviews-and-fair-ranking.md) |
| D14 | Never any revenue: no ads, affiliate links or donations; not a trader, no KvK; consumer-review rules as good practice | Keeps trader duties and ad cookies out | [0016](../adr/0016-non-commercial-hobby-site.md) |
| D15 | Lettermint (NL, EU-only) via plain `fetch`; free 300/month in the beta, Starter €10/month at launch | EU processor; its SDK fails the 7-day rule | [0012](../adr/0012-transactional-email-via-lettermint.md) |
| D16 | No fixed dates; milestones in order, phase by phase | Hobby project | PHASES §1 |
| D17 | A rating or review requires a logged visit (self-declared date, "Bezocht op …"); "Hoe wij reviews controleren" says visits are self-declared | Card-holder reviews are the product; honesty about what is checked | [0017](../adr/0017-visit-tied-reviews-and-fair-ranking.md) |
| D18 | Passport-first beta; after it: helpful votes and comments → follows → feed last | A feed needs content first | [0001](../adr/0001-product-scope-passport-first.md) |
| D19 | Video in a later milestone, specified now, started only if beta users ask (A12); the pipeline leaves room for it | Storage, moderation and Cloudflare-terms cost | [0008](../adr/0008-media-through-the-api-served-from-r2.md) |
| D20 | € saved (curated price); visit import (MuseoTrack, Cultra, CSV), bulk "already visited" onboarding, CSV/JSON export; Bayesian ranking; "hide ratings until I've visited"; beta seeding (A11) | Demand signals in prior art; tracker users lose data | [0001](../adr/0001-product-scope-passport-first.md), [0017](../adr/0017-visit-tied-reviews-and-fair-ranking.md) |
| D21 | Public pages server-rendered by React 19 and hydrated; logged-in screens stay an SPA | Search engines and a fast first paint; anonymous HTML is cacheable | [0009](../adr/0009-server-rendered-public-pages.md) |
| D22 | `admin.<domain>` behind Cloudflare Access (owner email + one-time PIN, like F1) and an app role check | A stolen user session cannot reach admin | [0004](../adr/0004-own-tunnel-and-access-gated-admin-host.md) |
| D23 | Code name `mjk` for packages, compose project, paths and images | The brand can change without touching code | [0006](../adr/0006-neutral-brand-and-code-name.md) |
| D24 | restic to a private R2 EU bucket (same account as media) with a bucket lock rule; accepted risk: one vendor for media and backups | Users' data cannot be re-fetched | [0011](../adr/0011-backups-to-a-locked-r2-bucket.md) |

ADR-0002 (stack) and ADR-0015 (search and jobs in PostgreSQL) record planning choices without a D-number.

## 4. Tech stack

Shared-stack pins are F1's as of today (its `package.json` files, which are newer than F1's A§3 text). New packages use the versions checked on 2026-11-01. **Every pin is re-checked against the 7-day release-age rule when it is installed** (P0, or the phase that adds it), and each new dependency gets an ADR-lite line in its PR. P0 checked every shared pin against the 7-day rule on 2026-11-01 (all at least 11 days old). It pins the images by the newest digest at least 7 days old: `postgres:18.6-trixie@sha256:74935e72…` (built 2026-10-06) and `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd…` (built 2026-10-23), because both tags have since moved to newer builds.

| Area | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript 6.0.3 strict, Node 26.10.0 (`.node-version`) | TS 7 forbidden. Erasable syntax only. `.ts` imports with extension |
| Package manager | pnpm 12.5.1 workspace | `minimumReleaseAge: 10080`, `strictDepBuilds`, `blockExoticSubdeps`, `--frozen-lockfile`. sharp's install script needs an `allowBuilds` decision [U P3b] |
| Lint/format | Biome 2.6.2 | `"preset": "recommended"`; `*.md`/`*.yaml` excluded (F1 gotcha) |
| Tests | Vitest 5.0.5 (`unit` + `integration`), msw 3.0.3, fast-check 4.10.2 | Integration on real PostgreSQL 18 (A§18) |
| E2E, accessibility | @playwright/test 1.64.1 (Chromium + WebKit, in the Playwright CI image), @axe-core/playwright 4.14.0 | Waterheight's pins. Passkeys via Chromium's virtual authenticator |
| Server | Hono 4.13.13 + @hono/node-server 2.1.5, undici 8.12.3, pino 10.4.0, croner 10.0.1, zod 4.6.7 | One image, roles in A§5 |
| Database | PostgreSQL 18.6, Kysely 0.29.7 + pg 8.23.1, kysely-codegen 0.20.0, dbmate 2.36.0 | Trusted extensions `pg_trgm`, `unaccent`, `citext`. Immutable migrations |
| Web | React 19.3.1, Vite 8.3.5 + @vitejs/plugin-react 6.1.2, TanStack Query 5.104.5 | No router library (`routeOf` as in F1), shared by server and client [U P1c] |
| SSR | `react-dom/server` (`renderToReadableStream` or `prerender` [U P1c]) in the `ssr` role; Vite 8 SSR build | ADR-0009, A§15.1 |
| i18n | @inlang/paraglide-js 2.29.1, @inlang/plugin-message-format 4.5.4 | Plugins load from `node_modules`, never a CDN (Waterheight gotcha) |
| Map | maplibre-gl 6.15.0 (lazy chunk), pmtiles 4.5.0; dev: @protomaps/basemaps 5.7.2, @maplibre/maplibre-gl-style-spec 26.4.4; go-pmtiles 1.31.2 in the server image | Waterheight ADR-0016 set-up; tiles on R2 (A§15.3) |
| Media | sharp 0.35.5 (prebuilt libvips, LGPL-3.0-or-later), file-type 22.3.0, own SigV4 client (~150 lines, `node:crypto`; P1d, for the tiles) | No AWS SDK. ffmpeg only in `mjk-media` (P7) |
| Auth | `node:crypto` (`argon2()`, HMAC, random bytes), @simplewebauthn/server 14.0.3 + @simplewebauthn/browser 14.0.0 (P2b), altcha-lib 2.8.0 + altcha 3.5.0 (`/dist/external`) | Own code (ADR-0007) |
| Email | Lettermint HTTPS API through `fetch` | `Mailer` interface with a fake for tests |
| Backups | restic 0.19.1 (built from source, Waterheight's pattern), `pg_dump` 18 | ADR-0011, A§17.6 |
| Edge | Caddy 2.11.7, cloudflared 2026.10.3, Cloudflare Access (Free), R2 (EU jurisdiction), Cloudflare DNS | Own tunnel (ADR-0004) |
| Images | Build `node:26.12.0-trixie-slim`; runtime `gcr.io/distroless/nodejs26-debian13:nonroot`; web `caddy:2.11.7-alpine`; `postgres:18.6-trixie`; `cloudflare/cloudflared:2026.10.3`; CI only: `mcr.microsoft.com/playwright:v1.64.1-noble`, Chainguard MinIO. All pinned by digest | sharp's prebuilt binaries need glibc, which distroless Debian 13 has [U P3b] |

### Reused / dropped / added vs F1 and Waterheight

| Piece (from) | Here | Why |
|---|---|---|
| Toolchain, pnpm policy, Biome, Vitest unit + integration, msw, fast-check (F1) | **reuse** | Same agents, same gotchas |
| Hono, Kysely + pg, dbmate, croner busy guard, pino, undici, heartbeat healthcheck, `packages/contracts` (F1) | **reuse** | Proven patterns; the web parses every API answer |
| `roles.sql` with file-secret passwords, `createTestDb()`, grants per migration (F1) | **reuse** | Least privilege, tested in CI |
| Hardened compose anchor, file secrets + GIDs, fixed bridges, own nftables table, tick/update timers, GHCR digest pull with rollback (F1) | **reuse** | Same host, same safety |
| Own tunnel, Access JWT checked at the origin (F1 ADR-0004) | **reuse, narrower** | Only on `admin.<domain>`; the public host is open |
| Caddy trusts only cloudflared's fixed /32 for the client IP (Waterheight ADR-0021) | **reuse** | The rate limiter must not take a client-chosen key |
| Strict CSP, no third-party browser requests, Zod `jitless`, React `style` rule (F1, Waterheight) | **reuse** | Removes a class of bugs; privacy principle |
| Paraglide + `check-i18n` (Waterheight) | **reuse** | NL + EN (D2) |
| MapLibre, PMTiles, `@protomaps/basemaps` style build, self-hosted glyphs and sprites, worker under CSP (Waterheight ADR-0006, ADR-0016) | **reuse** | Tiles on R2 instead of the disk (ADR-0014) |
| restic, locked bucket, prune from the workstation, monthly restore drill (Waterheight ADR-0011) | **reuse** | Users' data cannot be re-fetched (F1 could drop it; we cannot) |
| Playwright + axe, Chainguard MinIO as an S3 stand-in in CI (Waterheight) | **reuse, lighter** | Chromium + WebKit, not three engines; MinIO stands in for R2 |
| Prelaunch `X-Robots-Tag: noindex` profile (Waterheight) | **reuse** | Nothing is indexed before P5b |
| Privacy page naming Cloudflare first (Waterheight ADR-0021) | **reuse** | Every request passes through Cloudflare |
| Static-first publisher, brownout, k6 load tests, chaos, benches (Waterheight) | drop | Content changes on every write; niche traffic; SSR with a short edge cache instead |
| Owner-audience machinery, WireGuard owner site (Waterheight) | drop | No owner-only data; admin sits behind Access |
| Signed pull-based releases: cosign, promote gate (Waterheight) | drop | Same reasoning as F1 ADR-0002: one committer, GHCR digests and a gated `release` job are enough. Revisit if others commit |
| BOM table and `check-bom.ts`, `check-boundaries`, OpenAPI generators, CodeQL, Lighthouse, `harden-runner` (Waterheight) | drop | As in F1: exact pins, Dependabot cooldown and ADR-lite lines cover the supply chain |
| ECharts (F1) | drop | No charts in v1; progress bars are SVG and CSS |
| Watchdog role, public status page (Waterheight) | drop | healthchecks.io checks plus a status panel on the admin host |
| Accounts, sessions, passkeys, invites, bot protection | **added** | Multi-user site (ADR-0007) |
| Uploads, photo pipeline, R2 media bucket | **added** | User photos (ADR-0008) |
| `ssr` role | **added** | Public pages for people and search engines (ADR-0009) |
| Moderation, DSA flows, admin host | **added** | Hosting user content (ADR-0010) |
| Job queue and search in PostgreSQL, transactional email | **added** | ADR-0015, ADR-0012 |

## 5. Components

One server image (`ghcr.io/mwijkhuisen/mjk-server`) whose first argument picks the role (`node apps/server/src/main.ts <role>`), and one web image (`mjk-web`: Caddy, the client assets, map glyphs, sprites and style). Later `mjk-media` (ffmpeg worker, P7).

| Role | Kind | Does | DB login |
|---|---|---|---|
| `api` | daemon | Hono `:8080`, `/api/v1/*` JSON: auth, sessions, me/visits/wishlist/reviews, chunked uploads (writes `/srv/mjk/quarantine`), reports (DSA notices). `/api/admin/*` only on the admin host, with a Cloudflare Access JWT and a role | `mjk_api` |
| `ssr` | daemon | Hono `:8081`: renders public HTML (museum pages, lists, search results, public profiles, single reviews, legal pages) with React 19 from the Vite SSR bundle. Anonymous only (never reads a session), so pages are cacheable. Returns the app shell for logged-in routes. `sitemap.xml`, `robots.txt` | `mjk_ssr` (read-only, public views only) |
| `worker` | daemon | Postgres job queue (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`, no library): photo processing (sharp → AVIF/WebP), R2 uploads, email (Lettermint), museum sync (weekly), quarterly basemap refresh, stats and ranking, account deletion, export bundles, retention purges | `mjk_worker` |
| `migrate` | job | dbmate as `mjk_migrator` | `mjk_migrator` |
| `healthcheck` | probe | Heartbeat file under 120 s old | – |
| `sync-museums [--dry-run] [--seed] [--accept-drop <source>] [--accept-changes]` | job | One-off museum import (`--seed`, only while `museum` is empty) or diff: the worker's weekly code, `runSync()` (P1a; flags and exit codes in `docs/runbooks/museum-sync.md`) | `mjk_worker` |
| `admin <cmd>` | job | CLI, used until the admin UI exists. P1a: `museum flag`, `museum price`, `museum pin`, `museum export --csv`, `museum import --csv [--dry-run]`, `list publish`, `list show`, `match list`, `match resolve`, `change list`, `change apply`, `change reject`; later `invite create` (P2a), `user role`, `user trust` (P3b) | `mjk_api` |
| `backup` | job | `pg_dump -Fc` + restic of the dumps and `/srv/mjk/originals` to the private R2 EU backup bucket (own image stage or the restic binary in the server image [U]) | `mjk_backup` (read-only) |

**Caddy routes** (web image):

- On `<domain>`: `/assets/*` (immutable, `file` matcher) · `/map/*` (glyphs, sprites, style) · `/api/v1/*` → `api:8080` · `/api/admin/*` → 404 · everything else → `ssr:8081`.
- On `admin.<domain>`: `/assets/*` (immutable, `file` matcher, as on the public host) · `/api/admin/*`, `/api/v1/auth/*` (except signup), `/api/v1/me*` and `GET /api/v1/museums*` → `api` · any other `/api/*` → 404 · everything else → the admin SPA entry (`admin.html`, same web build). The `api` checks the Access JWT on every admin-host request (A§9).
- Media and tiles never pass through Caddy: they come from `media.<domain>` (R2). The `api` also refuses `/api/admin/*` unless the `Host` is the admin host.
- Headers: the CSP (A§15.6), `Cache-Control` on `/api/*` as the `api` sets it per answer (A§14: short `s-maxage` on public GETs, `private, no-store` on everything personal, mutations and errors); Caddy sets `no-store` only on its own error responses, where `handle_errors` also repeats the A§15.6 headers (A§17.2). Public HTML with a short shared cache [U A§15.1], and `X-Robots-Tag: noindex` until P5b.

```
visitor ─► Cloudflare (zone <domain>) ─► cloudflared ─► caddy ─┬─► ssr ──► postgres (mjk_ssr, read-only)
                                                              └─► api ──► postgres (mjk_api) ─► /srv/mjk/quarantine
owner ─► Cloudflare Access ─► admin.<domain> ─► cloudflared ─► caddy ─► api (/api/admin, JWT + role)
worker ─► postgres jobs ─► sharp ─► R2 media bucket (EU) ◄── browser via media.<domain>
worker ─► Wikidata SPARQL + RCE WFS (weekly) · Lettermint API (email)
backup ─► R2 backup bucket (EU, private, bucket lock)
```

## 6. Repository layout

```
apps/server/src/{main.ts, api/, ssr/, worker/, auth/, museums/, passport/, reviews/, media/, moderation/, mail/, db/, lib/}
apps/server/test/
apps/web/
  index.html, admin.html, vite.config.ts
  src/entry-server.tsx           # SSR entry, imported by the ssr role from the built bundle
  src/entry-client.tsx           # hydrateRoot on public pages; SPA for logged-in routes
  src/admin/                     # admin SPA (main.tsx; moderation queue, museum curation, notices)
  src/                           # routes, views, components, styles.css, lib (api client, zod jitless, time, map)
  messages/{nl,en}.json          # Paraglide messages; check-i18n keeps them in step
  project.inlang/                # Paraglide settings (plugins from node_modules)
packages/contracts/src/          # zod schemas for every API answer; export condition mjk-dist
db/migrations/                   # dbmate, YYYYMMDDHHMMSS_name.sql, never edited once applied
deploy/{compose.yaml, server/Dockerfile, web/{Dockerfile, Caddyfile}, host/, bin/, systemd/, postgres/roles.sql, tests/}
docs/{plan/, adr/, runbooks/, legal/}   # legal: privacy and terms drafts, Art. 30 register, notice templates
scripts/                         # record-fixture.ts (refuses under CI), check-i18n.ts, build-map-style.ts
test/                            # repo-level tests: build output, CSP, i18n, compose
```

## 7. Museum data

### 7.1 Sources and licences

Checked 2026-11-01 (research input in `docs/plan/research/museum-data.md`).

| Source | Licence | Use |
|---|---|---|
| **Wikidata** SPARQL (`query.wikidata.org`) | CC0 | Seed and weekly sync; key = QID. The query is pinned in `apps/server/src/museums/sources/wikidata.sparql` (P1a; its sha256 is pinned in the fixtures' meta files, so a change forces a re-recording; the sync sends the byte-identical constant in `sources/wikidata-query.ts`, because `tsc -b` emits no `.sparql` file into the image's `dist`, and a unit test keeps the two equal): every item with `P31/P279*` museum and `P17` Netherlands, selected once in a `DISTINCT` named subquery (Blazegraph's `WITH … AS %items`), then each kind of value in its own `UNION` branch that starts with `INCLUDE %items`, with every aggregate `COALESCE`d to "", and `hint:Query hint:optimizer "None"` so every group runs in its written order (the owner's probes on 2026-11-02: the item set alone is 1,437 items in 2.2 s, 1.6 s in the class-first order, and 1,430 in 6.9 s with the Caribbean filter; with the planner on, the full run took 42 s once and timed out the next time while 60 items took 1.4 s; with the order pinned, 15 s once and a timeout the next, most of it the Caribbean filter's `P131*` walked down from the four Caribbean items for every item, so the filter is now one to three `P131` hops up from the bound item as `OPTIONAL`s that must stay unbound with the hop filter the full run took 12.9 s for 1,430 items (1,437 before the Caribbean filter), and restricted runs 2.5 to 3.7 s; a second identical request a minute after a successful one timed out three times out of three [U why: the weekly run sends one request, and a failed run is retried by the job queue's backoff, 15 min doubling; the [box] run re-measures]; a join of the values as `OPTIONAL`s, and then a plain sub-select joined to the `UNION` even for three items, ran past the 60 s limit with HTTP 504, so the branches were evaluated over all of Wikidata; no zero-length path such as `P131?` outside the item set; under SPARQL 1.1 one error makes a whole aggregate an error, so no aggregated expression may fail; the named subquery is a Blazegraph extension [U: a WDQS engine change breaks the query, and the run then ends `wikidata_unavailable`]), **dissolved ones included** (closures need them), **the Caribbean Netherlands excluded** (owner, Q3: Q27561 and its three public bodies [U QIDs]). 1,361 NL museums not marked dissolved [U count and run time under the 60 s WDQS limit: the owner's recording (O1) and the [box] run]. **Fetched in batches** (owner, 2026-11-02, after O2): the full query timed out from the box (HTTP 504 after 65 s) while the same query for three items took 1.4 s, selection and Caribbean filter included, and four of six full runs that day timed out. So the sync sends the item list (the query's own `WITH` block, derived from it in `wikidata.ts`), then the details in batches of 200 with the restricted query (`VALUES` at its marker; the same text and sha256 the fixtures pin), one request at a time, 2 s apart: about 8 requests a run, merged into one answer for the parser. User-Agent `mjk-museum-sync/1.0 (+<repository URL or MJK_SYNC_CONTACT>)`, `Retry-After` honoured (seconds or a date, capped at 10 min, 3 tries; the research hit a 429) |
| **RCE "Musea in Nederland"**, WFS layer `overzichtmusea` | Public Domain Mark | 629 rows (metadata 2026-08-19): name, street, number, postcode, place, municipality. Cross-check and addresses. One WFS 2.0 `GetFeature` per run as GeoJSON in EPSG:4326 (the owner's recording, O1 2026-11-02: 629 features in 0.2 s, every one with a Point geometry in lon/lat and a `Pc6`, no invalid row). The typeName is `Veiligheid_van_Erfgoed:overzichtmusea`, the name data.overheid.nl lists for dataset 44332 (`rce:overzichtmusea` failed with `http_status`). Properties: `Museum` (name), `Adres` (the street alone), `Huisnummer` and `HnrToev` (joined: a letter directly, `8A`, anything else after a dash, `7-HS`), `Pc6`, `Woonplaats`, `Gemeente` (a name). There is no id property: the key is the GeoServer feature id `overzichtmusea.<n>` [U stable when RCE reloads the dataset]. All named once in `sources/rce.ts` |
| **museum.nl** | © Museumvereniging; "personal, non-commercial" use only; linking allowed | Never fetched, scraped or copied. Only a link per museum. The bare list may be protected by the Databankenwet [U]. A5 asks for a feed or permission |
| **Museumregister** | – | Only through Wikidata P166 = Q110989587 (502 items); no export found [U] |
| **OpenStreetMap** | ODbL (share-alike) | Not in our database. Only inside the basemap tiles, attributed on the map (A§15.3) |
| **Wikimedia Commons** (P18) | Per file, often CC BY-SA | **Self-hosted with attribution** (owner, 2026-11-01; ADR-0018). P1a stores P18's file name as `museum.commons_file` and contacts no Commons host; P3b checks the licence (CC0, public domain, CC BY, CC BY-SA), re-encodes the file in the photo pipeline and serves it from `media.<domain>` with plain-text attribution. Never hotlinked |
| **Google Places** | Terms allow storing only `place_id` (and lat/lng for 30 days) | Not used |

### 7.2 Data map (field → source)

| `museum` field | Wikidata | RCE | Curated | Notes |
|---|---|---|---|---|
| `wikidata_qid` | item | – | – | Main external key, unique; null only for a museum the owner adds by hand |
| `rce_id` | – | row key (629) | – | Reference only |
| `name`, `name_en` | label nl / en | name (cross-check) | override | `museum_alias` holds Wikidata aliases and names learned from imports |
| `lat`, `lon` | P625 (1,071) | WFS geometry, read in either axis order (NL's latitude and longitude ranges do not overlap, so a swap is detected) | fix in admin | A museum without coordinates is listed but not on the map. Inside the European-NL box (lat 50.7–53.7, lon 3.2–7.3), a CHECK; a point outside it is dropped at parse |
| `website` | P856 (907) | – | override | Linked, never fetched. `https://` only; an `http://` value is upgraded to `https://` (owner, 2026-11-02: 31 of the 60 recorded items had http only), counted as the note `website_upgraded`, and a real https value wins |
| `street`, `house_number`, `postcode` | P6375 (752), P281 (537) | street, number, postcode | override | Postcode normalised to `1234 AB`; RCE's structured fields first, then P6375 parsed into street, number, postcode and place (`sources/wikidata.ts`) [U parse rate: the [box] run] |
| `place`, `municipality_code` | P131 | place, municipality | override | Province comes from `municipality`, which the sync fills from the Wikidata answer: one or two P131 hops to a live item with a CBS code (P382, stored as `GM0363`), its nl label and its province's P300 (P1a; no second list source) |
| `registered` | P166 = Q110989587 (502) | – | – | "Geregistreerd museum" badge |
| `museumnl_url` | P973 (441, stale) | – | override | A link and a hint for import matching and the flag, never proof of participation |
| `categories` | P31 classes | – | override | Six categories (`art`, `history`, `natural_history`, `science_technology`, `ethnology`, `other`), a CHECK. `museums/categories.ts` maps the classes we are sure of; an item whose classes map to nothing is `other` [U O1: the table is completed from the recorded class counts]. A change queues |
| `closed_on` | P576 | – | override | A§7.5 |
| `description_nl`, `description_en` | description (CC0, short) | – | own text | Never museum.nl or Wikipedia text |
| `museumkaart_status`, `mk_since`, `mk_until`, `mk_last_verified_at` | – | – | owner + moderated reports | A§7.5 |
| `admission_adult_cents`, `price_verified_at` | – | – | owner (A6) | € saved (A§10) |
| `photo_policy` | – | – | owner + reports | `allowed` · `no_flash` · `forbidden` · `unknown`; shown at upload |
| `commons_file` | P18 (841) | – | hide | The Commons file name without `File:` (1–255 characters, no `#<>[]\|{}/` or control character). The seed sets it; a later change queues. The image itself is P3b's (ADR-0018) |
| `temp_closed`, `temp_closed_until` | – | – | owner | A temporary closure: a flag and an optional end date (null = until further notice), no free text (A§7.5) |
| `pinned_fields` | – | – | owner | The source-fed columns the owner has overridden (`admin museum pin`, A§7.5); the sync never writes them and counts them as `pinned` |
| `slug` | – | – | – | Made once at creation from the unaccented, lower-case name; on a collision `-<place>`, then `-2`. The sync never changes it (`mjk_worker` has no UPDATE on it). Only the owner's `admin museum slug <museum> <new-slug>\|--from-name` changes it (P1b, owner decision: applying a name change keeps the slug); every old slug is kept for good in `museum_slug_redirect` and answers 301 (A§14) |
| opening hours, exhibitions | – | – | – | Not stored; linked out (A§1) |

Measured on the owner's full recording (O1, 2026-11-02), 1,430 items: 1,420 valid (10 without an nl or en label, 0.7 %, under the 2 % guard), 1,106 with coordinates, 1,178 with a municipality, 580 with a postcode, 920 with a website (451 of them upgraded from `http://`), 880 with a Commons file, 503 registered (P166), 76 dissolved (P576). The P31 classes are mostly plain "museum" (1,114 of 1,344 live items). With every class that five or more items use mapped or neutral (`museums/categories.ts`), the seed gives 1,102 `other`, 113 history, 81 art, 33 science and technology and 19 natural history; the rest are curated. RCE: 629 rows. In the 60-item sample, the seed matched 38 of the 40 registered museums with coordinates to their RCE row (31 by postcode and name, 7 by distance and name; the lowest name similarity 0.86, the largest distance 58 m).

### 7.3 Matching

One matcher (`apps/server/src/museums/match.ts`, pure, property-tested) serves the sync, RCE rows, visit imports (A§10) and "report a change":

1. **QID** (directly, or through an RCE id already stored on a museum; a stored museum.nl URL counts only for imports and reports, because P973 on Wikidata is stale).
2. **Postcode + name:** the same 6-character postcode and a name similarity ≥ 0.4.
3. **Distance + name:** under 150 m (haversine, strictly) and a name similarity ≥ 0.5.
4. **Anything else** goes to the admin review queue. Nothing is merged automatically below rule 3.

Settled in P1a:

- **Names:**
  - The similarity is the best of the candidate's name and its aliases, after `normaliseName()`. That function lower-cases, folds accents (NFKD plus ß, ĳ, æ, œ, ø …) and turns punctuation into spaces.
  - It drops these whole words: `museum`, `musea`, `mus`, `het`, `de`, `t` (from `'t`), `van`, `der`, `den`, `en`, `in`, `stichting`, `stg`, `gem`. Place names stay. `mus`, `in`, `stg` and `gem` came from the RCE names' legal-form and abbreviation noise ("Markiezenhof, Gem. Bergen Op Zoom", "Mus Willet Holthuijzen"): on the full set they added one match and no ambiguous row.
- **`pg_trgm` in TypeScript:** `museums/trigram.ts` ports `similarity()` (shared ÷ union, as a float4; empty gives 0), so the matcher stays pure. It equals PostgreSQL 18 (builtin C.UTF-8) on 345 pairs (`trigram.int.test.ts`). The thresholds are compared as float4 too.
- **First rule decides:** the first rule with a passing candidate decides. One candidate is the match; two or more queue as `ambiguous`, and later rules are not tried.
- **Identity never changes by itself:**
  - A Wikidata row with an unknown QID that hits a museum by rule 2 or 3 queues, as `qid_conflict` when the museum has another QID (a merge or redirect) or `qid_link` when it has none.
  - An RCE row never takes a museum that already holds another RCE row.
  - Two new RCE rows on one museum both queue as `duplicate`.
- **Thresholds, calibrated on the owner's full recording** (O1, 2026-11-02: the pure seed plan on 1,344 live Wikidata items and 629 RCE rows; the [box] run re-checks them):
  - 492 RCE rows match (365 by rule 2, 127 by rule 3) and 137 queue: 115 with no candidate, 10 ambiguous, 12 duplicate (one museum, two RCE rows, such as a museum's second location).
  - Of the 15 weakest matches (similarity 0.41 to 0.55), all but one or two are true pairs; raising rule 2 to 0.45 would lose about four of them to avoid one. So 0.4, 0.5 and 150 m stay.
  - Seven matches lie more than 500 m apart (the largest 64 km), and six of those are true pairs with a wrong or rough coordinate on one side, so rule 2 has no distance cap. Wikidata's coordinates win (A§7.2): the owner fixes such an item on Wikidata or pins the field.
  - The misses wait in the match queue: the same museum more than 150 m away (299 m and 187 m seen), and twin candidates at one postcode (two museums in one building).

### 7.4 Sync and diff

- **Weekly** worker job `museum_sync` (croner with `protect`, Tuesday 03:17 Europe/Amsterdam [U]; enqueued unless one is queued or running). The `sync-museums` role runs the same code. Runbook: `docs/runbooks/museum-sync.md`.
- **Seed** (owner, Q1): `sync-museums --seed`, allowed only while `museum` is empty.
  - It creates every Wikidata item that is not dissolved, and matches the RCE rows against those museums.
  - After the seed, a new museum queues. The weekly job refuses with `not_seeded` while `museum` is empty.
- **One run** (`museums/sync.ts`, as `mjk_worker`):
  1. A `pg_try_advisory_lock`; another run → `sync_busy`.
  2. Both sources fetched and parsed. A fetch error → `wikidata_unavailable` or `rce_unavailable`, retried.
  3. The empty guard.
  4. The state is loaded, the plan made (`museums/diff.ts`, pure) and applied in one `REPEATABLE READ` transaction.
  5. One log line of counts per outcome; never a payload, name or URL.
- **Dry run:** the same plan inside a `READ ONLY` transaction. It writes nothing, not even a run row, and prints a summary of counts and codes only.
- **Staging:**
  - Each row lands in `museum_source_row` with its payload (the parsed, normalised row), the sha256 of its canonical JSON, and the run that first saw or last changed it.
  - A row the owner or an earlier run has decided (matched or ignored) keeps its decision; only undecided rows are matched again.
  - An unchanged re-run writes nothing: every row keeps its `ctid` and `xmin` (`sync.int.test.ts`).
- **Auto-applied (safe, default deny; owner, Q4):** each writes an applied `museum_change`, so the history is complete.
  - website, street, house number, postcode, place, municipality
  - `name_en`, the descriptions, `museumnl_url`, `registered`
  - `rce_id` when an RCE row is matched
  - coordinates that appear or move under 250 m [U]
  - new aliases (aliases are never removed)
- **Review queue (unsafe):** everything else.
  - **The match queue:** source rows that are `new` or `ambiguous`, with a reason (`no_candidate` · `ambiguous` · `qid_conflict` · `qid_link` · `duplicate`) and candidates; `admin match list|resolve`.
  - **The change queue:** pending `museum_change` rows for a museum we hold:
    - a name change, a move of 250 m or more (one `coordinates` change), `categories`
    - a new or changed P18 (`commons_file`), a P576 closure (`closed_on`)
    - a safe field going to null
    - a row that disappears from its source (`presence`)
  - The change queue is worked with `admin change list|apply|reject`.
  - Nothing ever deletes: no login holds DELETE on a P1a table. Pinned fields are skipped and counted (`pinned`); the owner pins and unpins them with `admin museum pin <museum> <field…> [--unpin]` (any source-fed field but the QID; `lat` and `lon` together), which leaves an applied `pinned_fields` change.
- **Idempotent queue:**
  - The same pending news is not added twice.
  - Different news for the same field supersedes it (`superseded`), and so does a source that reverts.
  - A row that comes back clears its `presence` change.
  - While a museum waits for a presence decision (a matched row is gone and its `presence` change is pending, or it went this run), the sync changes none of its fields: otherwise the remaining source takes them over and swaps them back when the row returns (the real fixtures showed it, O1). After `--keep` the next sync updates it from the remaining source.
  - A change the owner rejected is not proposed again while the source repeats it (counted as `declined`); different news for that field queues as usual. To hold a value against every source change, the owner pins the field (`admin museum pin <museum> <field…> [--unpin]`).
- **Empty guard** (F1 pattern): the run applies nothing, records a `refused` run and fails the job with `empty_guard` (not retried) when, for either source:
  - its envelope fails the schema
  - more than 2 % [U] of its rows are invalid
  - it answers under 90 % [U] of the last *applied* run's rows (first run: under 1,000 Wikidata or 500 RCE rows [U])
- **Guard baseline:** it moves only with an applied run. After checking, the owner lets one run below it through for one source with `sync-museums --accept-drop <source>`.
- **Mass-change brake** (P1a review): a source can pass the guard and still be wrong. RCE's feature ids are contiguous and may be positional [U], and a decided row is kept by its id, so a reload that renumbers them would put a neighbour's address on every museum matched to RCE as safe changes. So a sync (never the seed) that would apply safe changes to more than 10 % [U] of the museums held, and to at least 50 [U] museums, applies nothing: it records a `refused` run with `mass_change` and fails the job without a retry, as the empty guard does. After checking, the owner lets one run through with `sync-museums --accept-changes`, recorded as `museum_sync_run.accept_changes`.
- Tests use recorded SPARQL and WFS fixtures (`scripts/record-fixture.ts`, which refuses under `CI`), plus hand-made `edge` and `hostile` cases, and `week2`, a week of news derived from `normal`.

### 7.5 Curation

- **Museumkaart flag:** `museumkaart_status` (`participating` · `left` · `unknown`, default `unknown`) with `mk_since`, `mk_until` and `mk_last_verified_at`.
  - The owner sets it with the P1a tooling (`admin museum flag`; `participating` or `unknown` without `--until` clears `mk_until`; the bulk CSV `museum export|import`, then the admin UI) by hand (A6), from each museum's own website and members' reports (or the A5 answer), never by working through museum.nl's list or filter (database right, A§13.3). The P973 links are hints only. Every museum starts as `unknown`; nothing in P1a sets the flag from a source, and `mjk_worker` has no grant on it.
  - [U A9, answered before A6 starts] whether this hand curation is fine under the Databankenwet; A5's answer may replace it with a feed or a permission.
  - Members use "Meld een wijziging" on a museum page; reports go to the moderation queue, and the owner applies them as `museum_change` rows.
  - A museum that leaves keeps its history: `left` with `mk_until`, never deleted.
- **N:** the number of museums in the last **published list version**. The owner publishes a version from the admin (`admin list publish [--date D]`; `mk_list_version` holds only the date). Publishing copies the museums then `participating` and not hidden into `mk_list_member`, in one transaction, and refuses an empty list, a second version on one date, a date after today (Europe/Amsterdam, `list_in_future`) and a date not after the newest version (`list_not_newest`), because a version is never removed. N is their count, computed by the view `mk_list` and never stored or typed. Changing a status afterwards changes neither N nor the version's members (`mk-list.int.test.ts`); no login can DELETE a list row. The site shows N with that date, "37 van 512 · lijst nov 2026", because public counts disagree (426 to 539).
- **Admission price:** the adult price in cents with `price_verified_at`. A museum without a price is left out of € saved, and the page says how many were left out.
- **Overrides (pinned fields):** the owner keeps a source-fed value against every later source change with `admin museum pin <museum> <field…>` and releases it with `--unpin` (P1a). Only the fields the sync writes after the seed can be pinned (`PINNABLE_FIELDS` in `museums/fields.ts`: every source-fed column but the QID; `lat` and `lon` together); anything else is refused (`not_pinnable`). Each change leaves an applied `museum_change` of field `pinned_fields` with both lists.
- **Card price:** a committed per-year table (2026: €75 adult, €39 under 19), updated by PR.
- **Photo policy:** curated from the museum's house rules and reports, shown before upload (A§13.3).
- **Closures:**
  - A museum closed on Wikidata (P576) or by the owner gets `closed_on`. Its page shows "Gesloten"; its reviews stay but become read-only.
  - Visits before `closed_on` can still be logged.
  - A temporary closure (owner, Q6): `temp_closed` and `temp_closed_until` (null = until further notice), set by the owner, with no free text, so it needs no translation or moderation.

## 8. Data model (PostgreSQL 18)

Times are `timestamptz` in UTC. Visit dates are `date` (local). Money is integer cents. IDs are `uuid` from PG 18's `uuidv7()` (proven in P0: on PostgreSQL 18.6 it returns version-7 uuids that increase from one call to the next, and needs no grant; `apps/server/test/roles.int.test.ts`), except where a key is listed. Text from users is plain text with a length `CHECK`. A user's own rows reference `app_user` with `ON DELETE CASCADE`; records about others' actions (`museum_change`, `moderation_action`, `notice`) and `content_ip_log` use `ON DELETE SET NULL`; `audit_log` holds bare ids without a foreign key.

| Table | Key | Columns (outline) |
|---|---|---|
| `province` | `code` | name_nl, name_en (12 rows, seeded) |
| `municipality` | `cbs_code` | name, province_code |
| `museum` | `id` | slug (unique), A§7.2 fields (`commons_file`, `temp_closed`, `temp_closed_until` and `pinned_fields` included, P1a), `hidden`, `search` (`tsvector`, `dutch` config through the immutable wrapper `mjk_unaccent` (P1b): `unaccent()` itself is only STABLE; a SQL-standard body binds `public.unaccent` at creation, and `COST 250` (measured) keeps the planner from preferring a per-row call over the trigram indexes. Weights: name A; `name_en` and the aliases B; place and municipality name C. Kept by triggers, never by a grant: a BEFORE trigger on `museum` as the writing login, and two `SECURITY DEFINER` touch triggers on `museum_alias` and on a municipality rename (pinned `search_path`, no parameters, EXECUTE revoked from `PUBLIC`), which fire only on a real change, so an unchanged sync still touches no row. GIN on `search`; trigram GIN (`gin_trgm_ops`) on `mjk_unaccent(name)` and `mjk_unaccent(alias)`; btree on the sort key `(lower(mjk_unaccent(name)), id)` (the builtin C.UTF-8 collation sorts by code point) and on `(lat, lon)`), created_at, updated_at (set by a trigger, so no login needs a grant on it; since P1b it ignores an update whose only changes are `search` and `updated_at`, so a search recompute after an alias insert or a municipality rename, and P1b's backfill, keep it). CHECKs: the key formats, the NL box, https links, the one link-out host for `museumnl_url`, length caps, the six categories, the statuses, `mk_until ≥ mk_since`, `left` needs `mk_until`, a price of 0–20,000 cents |
| `museum_alias` | `id` | museum_id, alias, source (`wikidata` · `import` · `admin`), created_at; unique (museum_id, alias); never removed |
| `museum_slug_redirect` | `old_slug` | museum_id, created_at (P1b). A trigger writes the old slug on every slug change, so a row points at the museum, never at a slug: no chain. That trigger (`museum_slug_keep`) is `SECURITY DEFINER` (owner `mjk_migrator`, pinned `search_path`, no parameters, EXECUTE revoked from `PUBLIC`), so no login holds INSERT and none can forge a redirect. A guard trigger refuses (23505 `museum_slug_taken`) a slug that is another museum's old slug; a museum may take back its own |
| `museum_sync_run` | `id` (bigint) | mode (`seed` · `sync`), started_at, finished_at, wikidata_rows, rce_rows, counts `jsonb` (numbers and fixed codes), outcome (`applied` · `refused` · `failed`), code (fixed), accept_drop, accept_changes (the mass-change brake, A§7.4). The empty guard's baseline is the last applied run (P1a) |
| `museum_source_row` | (source, external_id) | payload `jsonb` (the parsed, normalised row), hash (sha256 of its canonical JSON), fetched_at, run_id (the run that first saw or last changed it), matched_museum_id, match_state (`matched` · `new` · `ambiguous` · `ignored`), match_rule (`id` · `postcode_name` · `distance_name` · `admin`), match_reason (`no_candidate` · `ambiguous` · `qid_conflict` · `qid_link` · `duplicate` · `dissolved`), candidate_ids, gone_since_run_id (set once, when the row disappears) |
| `museum_change` | `id` | museum_id, field (a column, or `new_museum` · `presence` · `qid_link` · `coordinates`), old and new `jsonb`, origin (`sync` · `admin` · `report`), source and external_id (the source row), run_id, state (`applied` · `pending` · `rejected` · `superseded`), reporter_id, decided_by (plain uuids until P2a adds the foreign keys to `app_user`), created_at, decided_at. At most one pending change per museum, field and source |
| `mk_list_version` | `id` | published_on (unique), published_by (P2a adds the foreign key), created_at. N is not stored: the view `mk_list` counts the newest version's members (P1a) |
| `mk_list_member` | (list_version_id, museum_id) | the museums `participating` when the version was published |
| `museum_stats` | `museum_id` | rating_count, rating_mean, bayes_score, aspect means and counts, review_count, visit_count, updated_at (worker) |
| `app_user` | `id` | email (`citext`, unique), email_verified_at, handle (`citext`, unique), display_name, password_hash (argon2id PHC string, null), role (`user` · `moderator` · `admin`), status (`active` · `banned` · `deleted`), banned_until, ban_reason, trusted_at, age_confirmed_at, terms_version, terms_accepted_at, settings (A§10), invite_id, created_at |
| `session` | `id` = sha256(token) | user_id, host (`public` · `admin`), method (`code` · `password` · `passkey`), created_at, expires_at, absolute_expires_at, last_used_at, reauth_at (the last sign-in or code on this session, A§9) |
| `email_code` | `id` | email, purpose (`signup` · `signin` · `email_change` · `delete`), code_hmac, attempts, pending (`jsonb`: a sign-up's handle, terms version, invite), expires_at, used_at, created_at |
| `passkey` (P2b) | `credential_id` | user_id, public_key, sign_count, transports, backed_up, name, created_at, last_used_at |
| `auth_challenge` | `id` | purpose (`altcha` · `webauthn`), host (`public` · `admin`), value_hash, expires_at, used_at (single use, 5 min) |
| `invite` | `id` | code_hmac (unique), created_by, note (no personal data), max_uses (default 1), uses, expires_at (default 14 days), created_at |
| `rate_limit` | (bucket, key, window_start) | count. Keys are user ids, emails, IP prefixes or `site` (site-wide counts, A§9, A§17.7), never full addresses |
| `visit` | `id` | user_id, museum_id, visited_on (null = "eerder, datum onbekend"), note (private, ≤ 2,000 chars [U]), source (`manual` · `import`), import_id, created_at. `UNIQUE NULLS NOT DISTINCT (user_id, museum_id, visited_on)` (PG 15+; at most one undated visit per museum) |
| `wishlist` | (user_id, museum_id) | created_at |
| `visit_import` | `id` | user_id, format, rows `jsonb` (deleted on confirm or after 7 days [U]), state, created_at |
| `review` | `id` | user_id (null after D10's "keep" choice), museum_id, visit_id (`ON DELETE RESTRICT`; null only after the "keep" choice, which first copies the date into `former_visited_on`), rating 1–5, aspect columns (A§11) 1–5 or null, body (≤ 5,000), state (`visible` · `removed`), former_member, created_at, edited_at. Unique (user_id, museum_id) |
| `review_revision` | `id` | review_id, rating, aspects, body, created_at |
| `media` | `id` | user_id, review_id (null until attached), kind (`photo`; `video` P7), state (`uploading` · `quarantined` · `processing` · `pending_review` · `approved` · `rejected` · `removed` · `failed`), declared_size, received_bytes, sha256, bytes, width, height, public_key (random), alt_text, consents_at, decided_by, decided_at, created_at |
| `media_variant` | (media_id, format, width) | object_key, bytes |
| `blocked_hash` | `sha256` | reason, moderation_action_id, created_at |
| `job` | `id` (bigint) | kind, payload `jsonb` (ids only; `mail_code`, `mail_invite` and the two account-notice mails add a sealed code and/or recipient address, nulled once sent, A§9), state (`queued` · `running` · `done` · `failed`), run_at, attempts, max_attempts, locked_at, locked_by, last_error (fixed code), created_at, finished_at |
| `data_export` | `id` | user_id, state, path, expires_at, created_at |
| `notice` | `id` | target_kind, target_id, category (`copyright` · `portrait` · `privacy` · `defamation` · `csam` · `threat` · `other_illegal` · `terms` · `appeal`), explanation, notifier_name and notifier_email (null allowed only for `csam`, A§13.1), good_faith, received_at, ack_sent_at, decision, decided_at, decision_sent_at |
| `moderation_action` | `id` | target_kind, target_id, affected_user_id (`ON DELETE SET NULL`), type (`approve` · `reject` · `remove` · `restrict` · `ban` · `unban` · `restore`), ground_kind (`law` · `terms`), ground_ref, facts, automated, actor_id, notice_id, sor_sent_at, created_at |
| `audit_log` | `id` (bigint) | at, actor_id, actor_kind (`user` · `moderator` · `admin` · `system`), action, target_kind, target_id, detail `jsonb` (codes and ids, never content or secrets). INSERT-only |
| `content_ip_log` | `id` | user_id (`ON DELETE SET NULL`: the row stays until its 30 days end), target_kind, target_id, ip (`inet`), created_at (30 days [U]) |
| `follow` (P6) | (follower_id, followee_id) | created_at |
| `comment` (P6) | `id` | review_id, user_id, body, state, created_at, edited_at |
| `helpful_vote` (P6) | (review_id, user_id) | created_at |
| `feed_item` (P6) | `id` | user_id, kind, ref_id, created_at (or a view, decided in P6c) |

**Public views** (`pub_museum`, `pub_museum_stats`, `pub_review`, `pub_media`, `pub_profile`, `pub_mk_list`): owned by `mjk_migrator` (not `security_invoker`), they expose only public rows and columns: visible reviews, approved media variants, profiles with their public parts, "voormalig lid" for detached reviews. Never an email, a note, a private visit or an IP.

- **P1b's views:**
  - `pub_museum` (`NOT hidden`; the A§7.2 public columns plus `municipality_name`, `province_code`, `search`, `name_folded`, `sort_name` and `mk_list_member`; never `hidden`, `pinned_fields`, `rce_id`, `wikidata_qid`, `commons_file` or the row's timestamps)
  - `pub_museum_alias`
  - `pub_slug_redirect` (an old slug and the current one, visible museums only)
  - `pub_province` (the 12, with visible-museum counts)
  - `pub_mk_list` (the newest version's date and N, as published)
- `hidden` is filtered in `pub_museum` only; the others join it.
- Every public query of the `api` reads only these views and `pub_search`, so P1c's SSR loaders reuse the same functions as `mjk_ssr`.
- **They are `security_barrier`** (P1b review, owner decision 2026-11-02): they are the isolation boundary for `mjk_ssr`, which must see public rows only even when the `ssr` process is compromised and sends its own SQL.
  - **What passes the barrier.** Only leakproof quals pass below a barrier. The text, uuid, date and float8 comparisons of the list, the keyset, the province and municipality filters, the detail and near-me do, and still reach `museum_sort_idx`, `museum_slug_key`, `museum_pkey` and `museum_lat_lon_idx`.
    - The list's ORDER BY becomes a top-N sort above the barrier, ~4 ms at 1,400 rows.
    - The category filter (`@>`) is not leakproof and runs above it.
    - `@@`, `<%` and functions such as `mjk_unaccent` are not leakproof either.
  - **What it stops:** the error and value channel. `views.int.test.ts` proves, as `mjk_ssr`, that a qual that raises only for a hidden value never raises through any view, and that it does leak a hidden alias and a hidden old slug once the barrier is off.
  - **What it does not stop:** plan instrumentation (re-review of P1b, N1).
    - `EXPLAIN (ANALYZE)` needs only SELECT. A leakproof qual runs below the barrier on its index, so `Rows Removed by Filter` counts the hidden rows that `NOT hidden` dropped there.
    - That confirms a guessed hidden slug, id or coordinate, and range counts on the sort key can rebuild hidden names.
    - `views.int.test.ts` pins this residual.
  - **Later views.** Later `pub_*` views (`pub_review`, `pub_media`, …) are barrier views too. Where hidden content is sensitive (removed, pending or DSA-removed), P3a and P3b decide before those views exist [U P3a]:
    - (a) keep hidden rows out of the indexes a caller's leakproof qual can reach (partial indexes `WHERE NOT hidden`, which the view's own predicate implies; plain unique constraints only for integrity);
    - (b) or accept the existence and count channel and record it.
- **Search goes through `pub_search(q)`** (P1b), not through the views: a `LANGUAGE sql STABLE SECURITY DEFINER` function owned by `mjk_migrator`, with `SET search_path = pg_catalog, pg_temp` and `SET pg_trgm.word_similarity_threshold = '0.55'` pinned on it, a static body (no dynamic SQL) in which `q` is only the bound value `$1` and every name is schema-qualified. Its three branches read `museum` and `museum_alias` with `NOT hidden` in each and return only ids of visible museums with a tier and a score, which the caller joins to `pub_museum`. EXECUTE is revoked from `PUBLIC` and granted to `mjk_api` and `mjk_ssr`. `search-explain.int.test.ts` explains its body (custom and generic plans) on the GIN indexes.

**Roles** (`deploy/postgres/roles.sql`, F1's pattern: file-secret passwords read with `pg_read_file`, idempotent, `NOSUPERUSER … NOBYPASSRLS`, `PUBLIC` revoked, one database per cluster):

- `mjk_migrator` owns every object and the database, and creates the trusted extensions.
- `mjk_api` reads and writes the tables behind its routes and enqueues jobs, except: SELECT and INSERT on `audit_log`; INSERT on `content_ip_log`; SELECT, INSERT and UPDATE (`decision`, `decided_at` only, as column grants) on `notice`; never UPDATE, DELETE or TRUNCATE on `audit_log`.
- `mjk_ssr` has `SELECT` on the `pub_*` views and nothing else. An integration test proves it cannot read any table.
- `mjk_worker` writes jobs, media, the museum sync tables and `museum_stats`, deletes for account deletion and purges, and inserts into `audit_log`; UPDATE of `notice.ack_sent_at`, `notice.decision_sent_at`, `moderation_action.sor_sent_at` and `data_export` after it mails (column grants on `notice` and `moderation_action`).
  - On `museum` (P1a, column grants, `WORKER_INSERT_FIELDS` and `SAFE_FIELDS` in `museums/fields.ts`): it can insert the source-fed columns but `closed_on`, and `slug` (the seed, which skips dissolved items). It can update only the safe set (A§7.4), so the name, the QID, `categories`, `commons_file` and `closed_on` change only through the owner (`admin change apply`; the QID through `admin match resolve`). It can neither insert nor change the Museumkaart flag, a price, the photo policy, a temporary closure, `hidden` or `pinned_fields`. Its `museum_change` rows cannot name an `origin` (the default is `sync`). It only reads the list tables.
  - `mjk_api` (the admin CLI in P1a) writes every `museum` column but `id`, `search`, `created_at` and `updated_at`, the match fields of `museum_source_row`, `museum_change`'s decision, and inserts list versions and their members.
  - **`museum_slug_redirect`** (P1b): SELECT for `mjk_api` and `mjk_worker` (the guard trigger runs as them), no INSERT for any login (the definer keep trigger writes it), nothing for `mjk_ssr`. **No login holds a grant on `museum.search`** (`grants.int.test.ts`).
  - **No login has DELETE or TRUNCATE on any P1a table** (`grants.int.test.ts`): a museum is never hard-deleted and a published list stays frozen. A later phase that purges `job` rows (P2a, A§13.2) adds its own grant.
- `mjk_backup` is a member of `pg_read_all_data` (`WITH INHERIT TRUE`, a Waterheight gotcha) and nothing else.
- **`audit_log` is INSERT-only:** no login has `UPDATE`, `DELETE` or `TRUNCATE` on it. Its 3-year purge [U] runs only through a function owned by `mjk_migrator`: `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, schema-qualified names, no parameters (the 3-year cutoff is a constant in the body), EXECUTE revoked from `PUBLIC` and granted to `mjk_worker` only.
- No row-level security: the `api` checks ownership, and every route has an authorization test (A§18). Pools are capped per process in code: worker 3, admin CLI 2, `api` 10, the `api` with a 5 s `statement_timeout` [U sizes and timeout, tuned after P1e].
- **Migrations are immutable:** dbmate `YYYYMMDDHHMMSS_name.sql`, up → down → up in CI, `kysely-codegen --verify`. Each phase grants its own tables (no default privileges).

## 9. Accounts and authentication

Own code following Lucia's `auth_session` approach (ADR-0007). No Google or Apple. Email is verified before any public content.

- **Sign-up (beta):** invite code, email, handle, display name, a 16+ confirmation, the current terms version, an ALTCHA solution and a honeypot field.
  - The `api` checks the rate limits, the ALTCHA (single use), the invite and the handle, then mails a code. The answer is the same whether or not the email already has an account.
  - `app_user` is created only when the code is entered (`email_verified_at`, `age_confirmed_at`, `terms_*` set), and the session starts. Open sign-up (P5a) drops only the invite.
  - Invite codes are 16 characters of Crockford base32 (80 bits), with `max_uses` 1 and `expires_at` 14 days by default (`admin invite create --uses N --days D [--email <address>]`). `uses` is incremented with `UPDATE … WHERE uses < max_uses AND expires_at > now()` in the transaction that creates the account; a used-up or expired invite makes the code verify fail with 403 and creates nothing.
- **Sign-in by email code:** email + ALTCHA → a 6-digit code by mail (codes, never links: mail scanners open links). Valid 10 min, 5 attempts, single use. Stored as an HMAC with a pepper from `app_keys`.
  - Issuing a code voids every unused code for the same email and purpose. Verify compares only with the newest code and names its purpose (`signin` · `signup` · `email_change` · `delete`); a code of another purpose fails like a wrong one.
  - `/auth/code` sends nothing for an email without an account (purposes `signin`, `delete`); the 202 and its timing are the same.
  - The `api` enqueues a `mail_code` job. Its payload holds the `email_code` id plus the code sealed with AES-256-GCM under the `code_seal` key from `app_keys`; sealed fields are the one exception to ids-only payloads (A§8). The worker opens it, sends the mail and sets the sealed field to null in the same transaction. An unsent sealed code is nulled at `expires_at`. Mail jobs are deleted on success, not kept 30 days. `mail_invite` (from `admin invite create --email <address>` or `POST /api/admin/invites` with `email`) seals the invite code the same way. `mail_invite`, the notice to the old address on an email change and the deletion confirmation (A§13.5) carry their recipient address sealed under `code_seal` next to the ids, nulled once sent; the address is never stored on `invite` or kept after the send. A code mail holds the code and fixed text only: no handle, display name or other submitted text.
- **Sign-in by password** (optional, set in settings): argon2id via `node:crypto` `argon2()` at no less than OWASP's floor (m = 19 MiB, t = 2, p = 1), with the highest m ≤ 64 MiB that keeps one hash under 250 ms on the VM [U P2a]; at most 2 hashes at once per process (a semaphore; a waiter gives up after 2 s with 429); passwords of 12 to 256 characters (else 400); no HIBP check (a third party). The PHC string carries the parameters, and a hash with older ones is redone at the next successful sign-in. One error for an unknown email and a wrong password, and the server hashes a dummy so the timing matches.
- **Sign-in by passkey** (P2b): `@simplewebauthn` with discoverable credentials and the browser's autofill UI; RP ID `<domain>`; challenges in `auth_challenge` (5 min, single use). `userVerification: 'required'` at registration and sign-in, and the server rejects an assertion without the UV flag; `expectedRPID` is `<domain>` and `expectedOrigin` is the origin of the host the request arrived on (`https://<domain>` or `https://admin.<domain>`); a challenge records its host. Adding a passkey needs a sign-in within the last 10 min [U]. An email code always remains a way in.
- **Sessions:** a 32-byte random token; the row id is sha256(token). Cookie `__Host-mjk_sid; HttpOnly; Secure; SameSite=Lax; Path=/`: host-only, so it never reaches `media.<domain>` and the public cookie never works on `admin.<domain>`. 30-day sliding expiry (extended when under 15 days remain). Sign-out deletes the row; "sign out everywhere" deletes them all. Absolute lifetime 180 days [U]; admin-host sessions 12 h idle, 7 days absolute [U]. Signing in deletes the row of any session cookie sent with the request and always issues a new token.
- **Admin host (D22):** the `api` verifies the Cloudflare Access JWT (like F1's A§10) first on every request whose `Host` is `admin.<domain>`, the auth routes included; an admin-host session is created only after that check and only for an email equal to the JWT's. `/api/admin/*` also needs that admin-host session, a user with role `moderator` or `admin`, and the JWT's email equal to the user's.
- **CSRF:** `SameSite=Lax`, our own Origin/`Sec-Fetch-Site` middleware on every unsafe method (A§14), and JSON-only mutations (anything else gets 415). Upload chunks are `PUT`, which is never a simple request, and the API sends no CORS headers.
- **Bot protection:** ALTCHA (`altcha-lib` 2.8.0 server, `altcha` 3.5.0 widget from `/dist/external`, so `worker-src 'self'` is enough) on sign-up and code requests, a honeypot field, the Postgres limiter, and one Cloudflare rate-limiting rule on `/api/v1/auth/*` (A2).
- **Client IP:** Caddy trusts only cloudflared's fixed /32, takes the right-most untrusted `X-Forwarded-For` address (Waterheight ADR-0021) and passes it to the `api` as `X-Mjk-Client` (A§17.2). The `api` reads `X-Mjk-Client` only when the TCP peer is `10.63.2.10` (caddy), otherwise it uses the peer's own address. The limiter keys on the /24 (IPv4) prefix, or the /56 (IPv6) prefix and its /48 at 4× the limit [U].
- **Rate limits** (fixed windows in `rate_limit`; numbers [U], tuned in P2a and the beta):

  | Action | Limit | Key |
  |---|---|---|
  | Code request | 3 per 15 min | (email, IP prefix) |
  | Code request | 20 per day | email (mail-bomb cap only) |
  | Code request, sign-up | 20 per hour | IP prefix |
  | Code check | 5 attempts | the code |
  | Code check | 30 failures per hour | IP prefix |
  | Code check | 500 failures per hour site-wide [U] | then verify also needs an ALTCHA solution |
  | Password sign-in | 5 per 15 min; 20 per hour | user; IP prefix |
  | Reviews and edits | 20 per day | user |
  | Photos | 30 per day, 1 GB in total | user |
  | Notices | 10 per day | IP prefix |

- **Roles and bans:** `user` · `moderator` · `admin`. The `admin user role` CLI sets the first admin. A ban sets `status`, `banned_until` and `ban_reason`, revokes every session, stops new content and sends a statement of reasons (A§13.1). Existing content stays unless a moderator removes it, with its own statement.
- **Account settings:** email change (code to the new address, a notice to the old one), password set, change or remove, passkeys, the session list, visibility and display settings (A§10), export (A§13.2) and deletion (A§13.5, after a fresh code).
  - Email change, password set/change/remove, passkey add/remove and "sign out other sessions" need a sign-in or code within the last 10 min (`session.reauth_at`), else 403 `reauth_required`.
  - Email changes, password changes and passkey removals delete every other session.
  - Lost mailbox: a password or passkey still signs in and can change the email; without either there is no recovery, and the owner never moves an account on request. This is stated on `/privacy` and in the sign-in help.
- **What is stored:** email, handle, display name, the password hash if set, passkey public keys, session hashes, code HMACs (24 h), the invite used, the 16+ confirmation time and terms version, IP prefixes in `rate_limit` windows, and the full IP of content-creating requests for 30 days [U]. No real name, birth date, phone number or tracking data.

## 10. Passport, wishlist, profiles and privacy

- **Visit:** user, museum, `visited_on`, a private note, source (`manual` · `import`). Several per museum, at most one per date and at most one undated. No future dates. `visited_on` may be null ("eerder, datum onbekend"), for onboarding and imports without dates.
- **Progress:** **card list** = distinct visited museums in the last published version's `mk_list_member`, against N, in total and per province ("37 van 512 · lijst nov 2026", A§7.5); **all time** = every museum ever visited, closed ones included; **per year** = distinct museums visited in a calendar year (dated visits only).
- **€ saved per calendar year:** Σ adult admission of the year's dated visits to museums that were `participating` on the visit date (`mk_since` null or ≤ date, and `mk_until` null or ≥ date), minus that year's card price for the user's card type. Museums without a price are left out and counted ("3 musea zonder prijs"). The adult price is used for everyone, which overstates the savings of under-19 holders; the page says so.
- **Wishlist:** user and museum. Filters "op mijn verlanglijst" and "nog niet bezocht" (A§14).
- **Onboarding:** after sign-up, "Welke musea heb je al bezocht?": search and province filters, tick many at once, then optionally add dates. The ticks become visits with no date; a museum that already has an undated visit gets none (A§8).
- **Import** (P2c): generic CSV (a name, QID or museum.nl URL, a date, optionally a note), MuseoTrack and Cultra exports [U formats: the owner supplies samples, A10], and `mjk` (our own JSON export: visits with notes, and the wishlist); at most 5,000 rows and 2 MB [U].
  - The A§7.3 matcher sorts rows into matched, ambiguous (the user picks) and unmatched (the user searches or skips). On confirmation they become `source = import` visits (and, for `mjk`, wishlist entries); an existing visit (same museum and date, undated included) is skipped.
  - From P3a the generic CSV also takes optional `rating` (1–5) and `review` columns, the member's own words only: each creates a review on the imported visit with the checks of `POST /reviews` (one per museum; over 5,000 characters → a row error).
- **Export:** JSON of every row that holds the member's id or email, covering every category in A§9 "What is stored": account fields (email, handle, display name, created_at, the 16+ time, terms version and acceptance, settings), sessions (method, created, last used; no ids), passkey names and dates, visits with notes, wishlist, imports, reviews with their revisions, ratings, media metadata, `content_ip_log` rows, statements of reasons sent to them, and notices and appeals filed with their email; CSV of visits and wishlist; a ZIP of their photo originals (A§13.2). Secrets are left out: the password hash, code HMACs, session ids and passkey public keys. The worker builds it in `/srv/mjk/exports` (A§17.1) and mails a signed link (valid 24 h [U]).
- **Profile** `/u/<handle>` (public by default, D12): display name, member since, public reviews and photos; the visit log, progress and wishlist only when the user makes them public. No avatars in v1 (initials): one less upload type to moderate. Handles: 3–30 of `[a-z0-9_]`, a reserved list, an old handle not reusable for 6 months [U].
  - Public visit logs show the month, not the day (the `pub_*` views truncate `visited_on`), and a visit appears publicly or in a feed only 24 h after it is logged [U owner decides in P2c]. The review form says the visit date is shown publicly (D17).
- **Settings** (`app_user.settings`, zod-checked): `visits_visibility` and `wishlist_visibility` (`private` default · `public`; `followers` from P6b), `hide_ratings_until_visited` (A§11), `card_type` (`adult` · `under_19`), `locale`. Email notifications: none before P6, then opt-in only.
- **Privacy:** private visits, notes and wishlists never reach the `pub_*` views (A§8), `sitemap.xml` or a log. Logged-in screens load their data from `/api/v1/me…` with `Cache-Control: private, no-store`.

## 11. Ratings and reviews

- **Rules** (D13, D17): one review per member per museum, citing one of the member's visits there, shown as "Bezocht op <date>" ("Bezocht" for an undated visit). Deleting the cited visit asks the member to pick another visit or delete the review. It needs a verified email and an active account. A closed museum's reviews are read-only.
- **Content:** overall 1–5 stars (required; drives the average). Optional aspects 1–5, stored as columns: collection, presentation, kid-friendly, accessibility, facilities, value for money (D13) [U final list in P3a]. Optional text: plain, any language, ≤ 5,000 characters, line breaks only (no HTML or Markdown), always rendered as text nodes. Up to 10 photos (A§12).
- **Scores:** the museum page shows the plain mean and the count. Lists are ordered by the **Bayesian average** `(C·m + Σ ratings) / (C + n)` with C = 5 and m = the global mean of visible ratings [U tune after the beta] [U: with C = 5 a single 5-star review still outranks a 4.6 average when m > 4.5; P3a and the beta tune C]. Aspects show a mean only from 3 ratings up [U]. The worker recomputes `museum_stats` in a debounced job after every change.
- **"Hide ratings until I've visited"** (the spoiler setting): on museums the member has not visited, scores and review texts stay folded behind "Toon beoordelingen". Public HTML is anonymous, so a tiny blocking same-origin script (not inline) reads a `localStorage` flag before the first paint and sets an attribute that CSS uses to fold the blocks: no flash, no cookie, still cacheable. Visited museums unfold once `/api/v1/me` answers [U P3a]. The flag is written at sign-in, re-synced from every `/api/v1/me` answer and cleared on sign-out; after a storage wipe (Safari clears script-written storage after 7 days without interaction) the first page may show scores until `/me` answers [U P3a].
- **Edits:** allowed at any time. The previous version goes to `review_revision` (for notices and moderation, never public), and the review shows "bewerkt op <date>".
- **Forbidden by the terms:** reviews by a museum's staff or for a reward, and more than one account per person.
- **"Hoe wij reviews controleren"** (linked beside every score, NL and EN): visits are self-declared, not checked; one review per member per museum; how the mean and the ranking are calculated; negative reviews are never suppressed or demoted, and moderation removes only illegal content and breaches of the terms; staff and rewarded reviews are forbidden; how to report a review.

## 12. Media (photos now, video P7)

- **Upload** (ADR-0008; the API answers in A§14):
  1. The browser calls `POST /api/v1/uploads` (declares kind, size and type; quota and rate checks) → an id and the chunk size.
  2. It sends `PUT /api/v1/uploads/<id>/chunks/<n>` in 8 MiB chunks, each far under Cloudflare's 100 MB body cap and timeout [U exact timeout]. The `api` streams them to `/srv/mjk/quarantine/<id>/upload`; Caddy caps the body size per route.
     - Each `PUT` needs `0 ≤ n < chunk_count` and exactly the expected `Content-Length` (8 MiB, the last chunk the remainder), checked before any byte is written. It is written at offset n × 8 MiB into a file never larger than the declared size; anything else → 422 and nothing stored.
     - At most 3 uploads in `uploading` per member (else 429), and at most 2 GB [U] declared across all open uploads (else 503).
  3. `POST /api/v1/uploads/<id>/complete`: size check, sha256 of the whole file, magic bytes with `file-type` 22.3.0 (JPEG, PNG, WebP only), the sha256 against `blocked_hash`, then a `media_process` job.
  4. Unfinished uploads are purged after 24 h.
- **Worker** (sharp 0.35.5, `limitInputPixels` ≈ 50 MP, `sharp.concurrency(1)`, `sharp.cache(false)`, one job at a time, a 120 s [U] timeout per photo job that ends it `failed` with a fixed code): orientation applied, then all metadata (EXIF, GPS) stripped, sRGB; AVIF and WebP at 400, 1200 and 2000 px wide (never upscaled); a random 128-bit key per photo (`p/<key>/<width>.<ext>`), not derived from any id. The quarantine file is deleted when a job ends `failed`.
  - An untrusted member's variants stay in `/srv/mjk/quarantine/<id>/v/` (state `pending_review`); the author and moderators see them only through the `private, no-store` preview routes (A§14).
  - A trusted member's photo, or one a moderator approves, is uploaded to the public R2 EU bucket by a `media_publish` job with the own SigV4 client (built in P1d, A§15.3) (state `approved`). A successful `media_publish` deletes the quarantine copies and moves the original to `/srv/mjk/originals`; a rejection deletes the quarantine copies and the original. Nothing reaches R2 (the media bucket or the backup) before approval (A§13.1).
- **R2 objects:** exact `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`. A Transform Rule on `media.<domain>` adds `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (A2). A Cache Rule on `media.<domain>/p/*` makes them eligible for cache with an Edge TTL of 4 h [U] and the browser TTL from the origin; the bucket's `r2.dev` public URL is off (A2), so nothing bypasses the zone's headers or the CSAM tool. CORS allows `GET` from `https://<domain>` only (the tiles' range requests). Pages use `<picture>` with AVIF and WebP `srcset`. Only files we re-encoded are stored there: **raw uploads are never served.**
- **Originals** stay private in `/srv/mjk/originals/<id>` (worker UID, never served), go into restic (A§17.6), and are deleted with the photo. An untrusted member's original stays in `/srv/mjk/quarantine/<id>/` until approval, so no unreviewed photo enters a backup.
- **Removal:** deleting a photo (by the member, a moderator or account deletion) deletes the variants (on R2 or still in quarantine) and the original at once, and adds the sha256 to `blocked_hash` when removed for illegality. The edge copy expires within the 4 h edge TTL. Urgent removals (CSAM, Art. 18, a court order) are also purged by URL in the dashboard (runbook `takedown-and-purge`). A scoped purge token for the worker stays [U P3c].
- **HEIC:** not decoded on the server (sharp's prebuilt libvips has no HEIC), and no WASM decoder in the browser (it would need `'wasm-unsafe-eval'`). The file input accepts JPEG, PNG and WebP, so iOS Safari hands over a JPEG [U P3b]. Anything else gets a clear message.
- **Limits:** a photo ≤ 25 MB and ≤ 50 MP; ≤ 10 per review; ≤ 30 per day per user; 1 GB per user. An optional alt text (≤ 250 characters). Before upload: three checkboxes (own photo · no recognisable people without consent · not focused on a protected artwork) and the museum's `photo_policy` (A§13.3).
- **Basemap tiles** live on the same bucket under `tiles/` (range requests from R2, never through the tunnel; A§15.3).
- **Wikimedia Commons images** (P3b, ADR-0018) share this pipeline:
  - A `commons_image` job reads a museum's `commons_file` (P1a stores it) and checks its licence against the allowlist: CC0, public domain, CC BY, CC BY-SA 1.0–4.0. Anything else is skipped with a fixed code.
  - It downloads the file from `upload.wikimedia.org` (allowlisted hosts, a size cap, no redirect followed) and re-encodes it as above: metadata stripped, AVIF and WebP, a random key, served from `media.<domain>` only.
  - The page shows plain-text attribution: the author (Commons' `Artist` HTML turned into text), the licence linked to its deed, the file page, and "resized".
  - The weekly sync re-checks the licence and sha1, and a deleted, replaced or relicensed file removes our copy. The owner can hide any image.
- **Video (P7, gated on beta demand, A12):** ≤ 60 s and ≤ 150 MB per clip, ≤ 2 per review and 5 per day [U]. The same chunked upload, then the `mjk-media` worker image (ffmpeg from Debian, not distroless; hardened Debian slim [U]): ffprobe checks first, then H.264/AAC 720p, CRF 23, `-movflags +faststart`, `-map_metadata -1`, plus a poster frame. Served from R2 with range requests (`media-src`, A§15.6): Cloudflare's terms allow video from a Cloudflare service such as R2, never from the tunnel. Queued for review like photos [U P7: every video].

## 13. Moderation, legal and privacy

ADR-0010. Research input: `docs/plan/research/legal.md`. One paid hour of Dutch legal advice before P3d's sign-off of the legal texts (A9) checks the [U] items below; its database-right question (A§7.5) is answered before A6 starts.

### 13.1 DSA

Whether a no-revenue private site falls under the DSA is [U] (the ACM guidelines say free services can). The plan assumes it does, because the hosting duties are cheap. ACM supervises.

| Obligation | Feature |
|---|---|
| Art. 11/12 points of contact | `/contact`: an email address, languages NL and EN, answered by a person |
| Art. 14 terms | `/voorwaarden`, versioned: content rules, how moderation works (human review, the hash blocklist), the upload licence (A§13.3). A change is announced by email and on the site; acceptance stores `terms_version` |
| Art. 16 notice and action | "Meld inhoud" on every review, photo, profile and (P6) comment: a category (the A§8 `notice` enum except `appeal`), reason, the exact item, name and email, a good-faith box. Name and email are required except for `csam` (DSA Art. 16(2)(c)); a `csam` notice without them gets no receipt mail. `threat` marks the queue item urgent and links `docs/runbooks/art18.md`. Automatic receipt, which holds the notice's reference and the target link, never the text or name the notifier typed; decision by email with the redress options |
| Art. 17 statement of reasons | Every removal, restriction, rejection or ban: the restriction, the facts, the ground (law or terms clause), whether it was automated (yes only for a hash match), redress. Email + a notice in the account; `sor_sent_at` |
| Art. 18 threats to life or safety | `docs/runbooks/art18.md`: report to the police at once |
| Art. 6 liability | Act quickly on a valid notice; the admin queue shows each notice's age |
| Art. 15, 20, 21 | Exempt as a micro service (Art. 19) [U]. A simple "bezwaar maken" link anyway, reviewed by the owner |

- **Moderation flow** (D9): text (reviews, P6 comments) goes live at once. Photos of untrusted accounts wait in a queue on the VM, never on R2, visible only to their author and moderators, through the `api`'s `private, no-store` preview routes ("wacht op controle", A§12, A§14); trusted = ≥ 3 approved photos and an account ≥ 14 days old, or set by a moderator [U]. The owner moderates alone at first, on the admin host. Each action writes `moderation_action` and `audit_log`.
- **CSAM:** Cloudflare's CSAM Scanning Tool on the zone (A2), which probably covers the R2 custom domain [U]. A match → remove, block the hash, ban, report (runbook) [U contacts].

### 13.2 GDPR

- **Lawful bases:** contract (Art. 6(1)(b)) for the account, passport, reviews and media; legitimate interest (Art. 6(1)(f): abuse prevention and legal claims) for rate limits, `content_ip_log` and moderation records; consent for optional emails (P6).
- **Privacy page** (`/privacy`, layered, following the AP's checklist; NL and EN): Cloudflare named first (every request passes through it; a US company relying on the EU-US Data Privacy Framework, upheld 2025-09-03, under appeal C-703/25 P). Processors: Cloudflare (DNS, tunnel, Access, R2, CSAM scanning; DPA through the Self-Serve Agreement §6.1 [U Free plan], recorded in A2) and Lettermint (email, EU only; DPA accepted in A4). Also retention, rights, the right to complain to the AP, the one cookie and the device storage below, the lost-mailbox position (A§9), and the owner's identity as a private person with an email address [U A9: whether that is enough].
  - Device storage, all user-requested and strictly necessary (ePrivacy Art. 5(3)): the theme and the ratings fold in `localStorage` (A§11, A§15.5), and, if P5a ships it, the offline outbox in IndexedDB (A§15.4).
- **Rights:** access and portability (export, A§10), rectification (settings), erasure (A§13.5), objection (contact).
- **Records** (P3d): an Art. 30 register in `docs/legal/`; `docs/legal/processors.md` (per processor: service, data, location, transfer basis, DPA version and date), referenced by the register; the breach runbook `docs/runbooks/breach.md` (the AP within 72 h).
- **Privacy by design (Art. 25):** EXIF/GPS stripped, no analytics, logs with fixed codes only (no IPs, emails or content), one strictly necessary cookie and device storage only for what the member asks for, so no banner.
- **Age:** 16+ confirmed at sign-up (UAVG art. 5).

| Data | Kept | Then |
|---|---|---|
| Sessions | 30 days, sliding; 180 days absolute; admin host 12 h idle, 7 days absolute [U] | Deleted at expiry, sign-out or ban |
| Email codes | 24 h (a code works for 10 min) | Deleted |
| `rate_limit` windows (emails, IP prefixes, site-wide counts) | Window + 24 h | Deleted |
| `content_ip_log` (full IP) | 30 days [U owner confirms in P3d], also after the account is deleted | Deleted |
| Notices, moderation actions, and the text of removed reviews and comments (in `moderation_action.facts`) | 3 years [U] | Deleted by the worker |
| Removed photos | Not kept: variants and original deleted at once; only the sha256 stays in `blocked_hash` | CSAM: reported, then deleted, never kept; a copy already in the locked backup cannot be deleted before its lock ends and ages out within 35 days [U A9] |
| `audit_log` | 3 years [U] | Purge function (A§8) |
| Job rows | 30 days after they finish; mail jobs deleted on success, a sealed code or recipient address nulled once sent, a code also at `expires_at` (A§9). The purge and its grant arrive with P2a, the first job that carries personal data; P1a's `museum_sync` jobs hold no payload | Deleted |
| Unfinished uploads, quarantine files | 24 h (pending-review copies: until decided, or until the photo or its account is deleted) | Deleted |
| `visit_import` rows (the raw file) | 7 days after creation, or on confirm [U] | Deleted |
| Export bundles and `data_export` rows | 7 days (link valid 24 h [U]) | Deleted |
| `invite` rows (the note holds no personal data) | 90 days after expiry or use [U] | Deleted |
| `museum_change.reporter_id` | 3 years [U] | Set to null |
| Reserved handles of deleted accounts | 6 months [U] | Released |
| Review revisions | As long as the review | Deleted with it |
| `blocked_hash` | Indefinitely (a hash only) | – |
| Deleted accounts in backups | Age out ≤ 35 days [U restic retention, A§17.6] | – |
| Accounts | Until the user deletes them | A§13.5 |

### 13.3 Copyright and portrait rights

- **No panorama freedom inside a museum:** Aw art. 18 covers only works placed permanently in public places, which museums are not [U]. Art. 18a allows incidental inclusion. Copyright runs 70 years after the author's death (art. 37). Portraits: Aw art. 21.
- **Terms (upload licence):** the user keeps the copyright and warrants they took the photo and hold the rights. They grant a non-exclusive, royalty-free licence to store, transcode and display it on the site, credited by handle. The licence ends on deletion (backups age out, A§13.2).
- **At upload:** the three checkboxes (A§12) and the museum's `photo_policy` (house rules are contractual).
- **Takedown:** the Art. 16 form offers the `notice.category` enum (A§8): copyright, portrait right, privacy, defamation, CSAM, threat, other illegal content, terms breach. Repeat infringers are banned [U threshold].
- **Our own sources:** no museum.nl text, images or list extraction (database right, A§7.1). "Museumkaart" only descriptively, plus the "not affiliated" footer (ADR-0006).

### 13.4 Reviews and consumer law

- **Not a trader** (D14, ADR-0016) [U A9], so the UCPD review duties do not bind; they are followed as good practice: "Hoe wij reviews controleren" beside every score, the staff and reward ban, no suppression of negative reviews (A§11).
- **Defamation:** the reviewer is primarily liable. A court can order the reviewer's identity disclosed (Lycos/Pessers, HR 2005), which is why the email and the 30-day IP log are kept.
- **Disclaimer:** museum information is given without guarantee; "report a change" corrects it.

### 13.5 Account deletion choice

Settings → delete account → a fresh email code → the choice (D10):

| | Delete everything | Keep reviews as "voormalig lid" |
|---|---|---|
| Profile, sessions, passkeys, visits, wishlist, settings, exports | Deleted | Deleted |
| Photos (variants on R2, pending copies in quarantine, originals) | Deleted | Deleted |
| Reviews and ratings | Deleted | Kept without photos; `user_id` cleared, shown as "voormalig lid"; revisions deleted; no longer editable |
| P6 comments, votes, follows | Deleted | Deleted |

- The page warns that kept review text can still identify the author [U].
- A deletion job runs in the worker: the user turns `deleted` and loses every session at once, and the rows go within minutes. R2 variants, quarantine copies and originals are deleted at once; edge copies expire within 4 h (A§12). Then `museum_stats` is recomputed and a last email confirms it (its address sealed in the job, A§9).
- **Not erased** (Art. 17(3)(e), legal claims): notices and moderation actions about the user, with the user id set to null, for 3 years [U]; notices the member filed, for 3 years [U]; `content_ip_log` rows until their 30 days end; `audit_log` rows, which hold ids only.
- Backups age out within 35 days [U]. Deletions since the snapshot are re-applied from production's `audit_log` when it survives. For a full loss, they come from the owner's deletion notices: the deletion job mails the owner "<account id> deleted <time>" (ids only) [U]. The restore runbook keeps the site in maintenance until those deletions are re-run (A§17.6).
- The handle stays reserved for 6 months [U]. Nothing can be undone.

## 14. API surface (`/api/v1`, JSON, zod contracts in `packages/contracts`)

Served by the `api` role (A§5). Public routes are anonymous: they never read the session, so their answers are the same bytes for everyone and can be cached. Everything personal sits under `/me` (A§10).

**Auth levels:** `public` · `member` (a session on this host, account `active`, email verified) · `poster` (member + the current terms version accepted, else 403 `terms_required`; every route that creates public content) · `self` (the row is the member's own; another member's private row is a 404, never a 403) · `mod` / `admin` (admin host only).

**Auth** (`/auth/*`: the path of the Cloudflare rate-limiting rule, A2)

| Route | Level | Does | Phase |
|---|---|---|---|
| `GET /auth/altcha` | public | a single-use ALTCHA challenge (`auth_challenge`, 5 min) | P2a |
| `POST /auth/signup` | public | invite, email, handle, display name, 16+, terms version, ALTCHA, honeypot → mails a code; 202 whatever the email | P2a |
| `POST /auth/code` | public | email, purpose, ALTCHA → mails a code (nothing for an email without an account); 202 whatever the email | P2a |
| `POST /auth/code/verify` | public | email, purpose and code → 200 with `Set-Cookie` (completes a sign-up or signs in); only the newest code of that purpose counts (A§9) | P2a |
| `POST /auth/password` | public | email + password → 200 with `Set-Cookie`; one 401 for every failure | P2a |
| `POST /auth/passkey/options` · `POST /auth/passkey/verify` | public | WebAuthn challenge, then the assertion → `Set-Cookie` | P2b |
| `POST /auth/signout` · `POST /auth/signout-all` | member | delete this session · every session | P2a |

On `admin.<domain>` the same routes (signup aside: 404) create a session with `host = admin`, only after the Access JWT check and only for the JWT's email; a session works only on the host that created it (A§9).

**Me, visits and wishlist** (all `self`, `private, no-store`)

| Route | Does | Phase |
|---|---|---|
| `GET /me` · `PATCH /me` | handle, display name, email, role, settings (A§10), `terms_current`; 200 with `"user": null` when signed out, so public pages log no failed request · display name and settings | P2a |
| `POST /me/terms` | accept the current terms version | P3d |
| `POST /me/email` · `POST /me/email/verify` | a code to the new address, a notice to the old one; ends every other session; re-authentication within 10 min, else 403 `reauth_required` (A§9) | P2a |
| `PUT /me/password` · `DELETE /me/password` | set or change (12–256 characters) · remove; re-authentication as above; a change ends every other session | P2a |
| `GET /me/sessions` · `DELETE /me/sessions/:id` | method, created, last used; never a token · sign out another session (re-authentication within 10 min, A§9) | P2a |
| `GET /me/passkeys` · `POST /me/passkeys/options` · `POST /me/passkeys` · `PATCH /me/passkeys/:id` · `DELETE /me/passkeys/:id` | add (after a sign-in within 10 min [U]), rename, delete (also after re-authentication; ends every other session) | P2b |
| `GET /me/visits` · `POST /me/visits` | keyset list · museum, `visited_on` (null allowed, no future date), note ≤ 2,000 → 201; the same museum and date → 409 | P2c |
| `PATCH /me/visits/:id` · `DELETE /me/visits/:id` | a visit a review cites → 409 until the review cites another visit or is deleted (A§11) | P2c |
| `POST /me/visits/bulk` | onboarding: up to 200 museum ids [U] → undated visits; existing ones skipped | P2c |
| `POST /me/imports` · `GET /me/imports/:id` · `POST /me/imports/:id/confirm` · `DELETE /me/imports/:id` | the file's text inside JSON (`format`: `csv` · `museotrack` · `cultra` · `mjk` (A§10), `content` ≤ 2 MB and ≤ 5,000 rows [U], else 413) → matched, ambiguous and unmatched rows (A§7.3); confirm with the member's choices → `source = import` visits | P2c |
| `GET /me/wishlist` · `PUT /me/wishlist/:museum_id` · `DELETE /me/wishlist/:museum_id` | idempotent, 204 | P2c |
| `GET /me/museums` · `GET /me/museums/:slug` | the `/museums` filters plus `visited` (`yes` · `no`) and `wishlist` · my visits there, the wishlist flag, my review id | P2c |
| `GET /me/progress` · `GET /me/savings?year=` | card list against N with the list date, per province, all time, per year · € saved, naming the museums without a price (A§10) | P2c |
| `GET /me/moderation` | statements of reasons sent to me (A§13.1) | P3c |
| `POST /me/exports` · `GET /me/exports/:id` | 202, the worker builds it and mails a link · the bundle, for this member's session only, until the link expires (24 h [U]) | P2c (CSV/JSON), P3d (photo ZIP) |
| `POST /me/deletion` | a fresh email code (purpose `delete`) + the D10 choice → 202 and the deletion job (A§13.5) | P3d |

**Museums, reviews, users** (public unless marked)

| Route | Does | Phase |
|---|---|---|
| `GET /museums` | filters `q` (1–100 code points), `province`, `municipality`, `category`, `mk=participating`, `min_rating` and `kid_friendly` (P3a); `sort` (`rank` default · `name`; until P3a `rank` orders like `name`); keyset paging plus `total`. With `q` the order is relevance: full-text hits (`websearch_to_tsquery` on the unaccented `q`, by `ts_rank`), then name trigram hits, then alias-only trigram hits (`<%`, by `word_similarity`, threshold 0.55 set by the `pub_search` function itself, A§8), then the sort key and the id | P1b |
| `GET /museums/points` | every visible museum with coordinates, compact (id, slug, name, lat, lon, Museumkaart status, category), for the map (A§15.3) | P1d |
| `GET /museums/near?lat=&lon=` | the k nearest visible museums with coordinates that are not permanently closed (`limit` 1–50, default 20; no radius cap): a bounding box that holds the disk of radius r, doubling from 2 km until the k-th distance is at most r or the box covers the NL box, then haversine in SQL in double precision, ties by id (ADR-0015); more than 3 decimals or outside the NL box → 400; `private, no-store`; never logged | P1b |
| `GET /museums/suggest?q=` | up to 10 names for the search box | P1b |
| `GET /museums/:slug` | A§7.2 fields, `museum_stats` (P3a), `mk_list` (`published_on`, `n`, `member`, or null); an old slug → 301 to the current one (`s-maxage=3600`, never a chain); hidden or unknown → 404; a slug that fails `^[a-z0-9]+(-[a-z0-9]+)*$` or 120 characters → 400 | P1b |
| `GET /museums/:slug/reviews` · `GET /museums/:slug/photos` | visible reviews (`sort` [U P3a]) · approved photos | P3a, P3b |
| `POST /museums/:slug/changes` | poster: "Meld een wijziging" → a `pending` `museum_change` (origin `report`), 202 | P3c |
| `GET /provinces` · `GET /mk-list` | the 12 provinces with counts · the published list version (date, N) | P1b |
| `GET /reviews/:id` | one visible review: author handle or "voormalig lid", "Bezocht op", rating, aspects, body, photos | P3a |
| `POST /reviews` | poster: museum, the cited visit, rating, aspects, body, `media_ids` → 201; not one's own visit → 422; a second review → 409; a closed museum → 409 | P3a |
| `PATCH /reviews/:id` · `DELETE /reviews/:id` | self: edit (the old version goes to `review_revision`) · delete | P3a |
| `GET /users/:handle` | display name, member since, counts; visits, progress and wishlist only when public (A§10); an old handle → 301 [U] | P2c |
| `GET /users/:handle/reviews` · `/photos` · `/visits` · `/wishlist` | keyset paging; a private list → 404 | P2c–P3b |
| `PUT /reviews/:id/helpful` · `GET /reviews/:id/comments` · `POST /reviews/:id/comments` · `PATCH /comments/:id` · `DELETE /comments/:id` | votes and comments | P6a |
| `PUT /users/:handle/follow` · `DELETE /users/:handle/follow` · `GET /feed` | follows · the feed (anonymous → 401) | P6b, P6c |
| `GET /healthz` | `select 1` → 200 `{"ok":true}`, else 503 `{"ok":false}`; `no-store`; the `mjk-update` smoke test calls it with `Host: <domain>` (A§17.5) | P1b |

**Uploads, media, reports**

| Route | Level | Does | Phase |
|---|---|---|---|
| `POST /uploads` | poster | `kind`, `size`, `type`, optional `review_id`, the three consents → 201 `{id, chunk_size, chunk_count}`; size, type, consent, quota and rate checks before any byte is stored; a 4th open upload → 429; over the total open-upload cap or under the disk guard → 503 (A§12) | P3b |
| `PUT /uploads/:id/chunks/:n` | self | `application/octet-stream`, over 8 MiB → 413; `n` outside `0 ≤ n < chunk_count` or a length other than expected → 422, nothing stored (A§12); a re-sent chunk with the same bytes is accepted | P3b |
| `POST /uploads/:id/complete` | self | sha256 → 202 and a `media_process` job; wrong magic bytes → 415; a missing chunk, extra bytes, a sha256 mismatch or a blocked hash → 422 | P3b |
| `GET /uploads/:id` · `DELETE /uploads/:id` | self | state and, once approved, the variant keys · abort | P3b |
| `GET /uploads/:id/preview?w=400\|1200` | self | a pending variant read from quarantine, sent with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (A§12) | P3b |
| `PATCH /media/:id` · `DELETE /media/:id` | self | alt text · delete the variants and the original | P3b |
| `POST /reports` | public | DSA Art. 16 notice: `target_kind`, `target_id`, category (the A§8 enum except `appeal`, which only `POST /appeals` creates; `appeal` here → 422), explanation, name, email, `good_faith: true`, ALTCHA → 202 and a receipt by email (reference and target link only, A§13.1); a missing field → 422, except that name and email are optional for `csam` (DSA Art. 16(2)(c); no receipt without an email); `threat` marks the queue item urgent; 10 per day per IP prefix | P3c |
| `POST /appeals` | public | "bezwaar maken": the signed reference from a statement of reasons or a decision email + an explanation → 202 (stored as a `notice` with category `appeal`); a forged or expired reference → 422 | P3c |

**Admin** (`/api/admin/*`): only when the `Host` is `admin.<domain>` (else 404, at Caddy and in the `api`), with the Access JWT verified as in ADR-0004, an admin-host session, role `moderator` or `admin`, and the JWT's email equal to the user's (D22). Every write inserts one `audit_log` row; every answer is `private, no-store`.

| Route | Role | Does | Phase |
|---|---|---|---|
| `GET /status` | mod | jobs per state, failed jobs with their codes, sync runs, the last backup and drill, disk, queue ages, the month's mails against `MJK_MAIL_CAP` (the status panel, A§17.7) | P3c |
| `GET /queue?kind=` | mod | `photo` · `notice` · `match` · `change`, oldest first, each with its age (Art. 6) | P3c |
| `GET /media/:id/preview` | mod | a pending variant from quarantine, with the headers of `GET /uploads/:id/preview` | P3c |
| `POST /media/:id/approve` · `POST /media/:id/reject` | mod | a `media_publish` job uploads the variants to R2, then the photo is public · reject with a statement of reasons; the quarantine copies and the original are deleted (A§12) | P3c |
| `GET /notices` · `GET /notices/:id` · `POST /notices/:id/decision` | mod | the notice and its target as reported; the decision mails the notifier with the redress options | P3c |
| `POST /actions` · `GET /actions?target=` | mod | `remove` · `restrict` · `restore` · `ban` · `unban`, with the ground (law or terms clause) and the facts → `moderation_action`, the statement of reasons, `blocked_hash` on removal for illegality | P3c |
| `GET /museum-changes` · `POST /museum-changes/:id/apply` · `POST /museum-changes/:id/reject` | mod | sync diffs and members' reports | P3c |
| `GET /museums` · `POST /museums` · `PATCH /museums/:id` | admin | curation (A§7.5): Museumkaart status and dates, adult price, photo policy, closures, `hidden`, overrides; a museum added by hand | P3c (CLI from P1a) |
| `GET /sync-runs` · `GET /sync-runs/:id` · `POST /source-rows/:id/match` | admin | counts per outcome, queued diffs, match resolution (a museum, new or ignore) | P3c |
| `POST /list-versions` | admin | publish a list version: copies today's `participating` museums into `mk_list_member`; N computed | P3c |
| `GET /appeals` · `POST /appeals/:id/decision` | admin | appeals, reviewed by the owner (A§13.1) | P3c |
| `GET /invites` · `POST /invites` · `DELETE /invites/:id` | admin | optional `email` → a `mail_invite` job; the code is shown once; only its HMAC is stored | P3c (CLI from P2a) |
| `GET /users?q=` · `GET /users/:id` · `PATCH /users/:id` | mod reads · admin writes | exact handle or email lookup; role and `trusted_at`; a moderator changing a role → 403 | P3c |
| `GET /audit` | admin | the audit log, read-only, keyset paging | P3c |

**Rules**

- **Shapes:** the A§8 column names (snake_case, no mapping layer, as F1), times as ISO-8601 UTC strings, visit dates `YYYY-MM-DD`, money in integer cents. Every answer has a strict zod contract in `@mjk/contracts`. An integration test parses each route against it, the `ssr` loaders return the same contracts (A§15.1), and the web parses every answer (jitless Zod).
- **Requests:** query strings and bodies parse with strict schemas, so an unknown parameter or key → 400. Mutations take only `application/json` (else 415); the upload chunks only `application/octet-stream`. Body caps at Caddy and in the `api`: 64 KB, imports 2 MB, chunks 8 MiB. The `api`'s cap reads only the headers (P1b): a `Content-Length` over the cap → 413 `too_large`, and until P2a a `Transfer-Encoding` (a body of unknown length) → 400, since no route reads a body before P2a; P2a revisits it with its JSON routes. `/api/admin/*` answers 404 before the cap.
- **CSRF** (A§9): `SameSite=Lax`, plus our own middleware on every non-GET that requires `Sec-Fetch-Site: same-origin` or an `Origin` equal to the host's origin (else 403); hono's `csrf()` covers form types only [U]. No CORS headers.
- **Status codes:** 200 · 201 · 202 (a mail or a job follows) · 204 · 301 (an old slug or handle) · 400 `bad_request` · 401 `unauthorized` · 403 `forbidden` / `terms_required` / `reauth_required` / `banned` · 404 `not_found` · 409 `conflict` · 413 `too_large` · 415 `unsupported_type` · 422 `invalid` · 429 `rate_limited` with `Retry-After` · 500 `internal` · 503 `unavailable`.
- **Errors are fixed:** `{"error":"<code>"}`, and on 400 and 422 a `fields` list with the names of the failing schema paths, never their values. No answer or log echoes input, a header, a token, a code, an email or a database message. Auth answers never tell whether an email has an account, and take the same time (A§9).
- **Paging:** keyset everywhere, `?cursor=<opaque>&limit=1..50` (default 20) → `{"items":[…],"next_cursor":…}`. The cursor is base64url of the last sort key plus the id (with `q`: the tier and score too), at most 4,096 characters, decoded through a strict schema before any SQL; a malformed one, or one of the other mode, → 400. No offsets.
- **Cache-Control** (set by the `api` per answer):
  - public GETs: `public, max-age=0, s-maxage=60` [U P5a tunes it; Cloudflare caches JSON only through the Cache Rules of A§17.7]; `/museums/points` `s-maxage=300`; a 301 `s-maxage=3600`
  - `/me*`, `/auth/*`, `/uploads*`, `/museums/near`, every mutation, every 4xx and 5xx, and all of `/api/admin/*`: `private, no-store`
  - a removed review can stay at the edge for up to the `s-maxage`, a removed photo's variants for up to the 4 h edge TTL (A§12); an urgent removal purges by URL
- **Rate limits:** the A§9 table; a refusal is a 429 and logs only the bucket's name.
- **Request logs:** one line each: method, route pattern (`/museums/:slug`, never the raw path or query), status, duration, request id (invariant 8). The `api` generates the request id itself and returns it as `X-Request-Id`; a client's header is ignored. The pattern is the first matched route that is not a global middleware (Hono 4.13 lists `app.use('*')` as `/*`), or `unmatched` (P1b).

## 15. Frontend

### 15.1 Server rendering and hydration

- One Vite 8 build of `apps/web`, three outputs: the client bundle (`src/entry-client.tsx`), the SSR bundle (`src/entry-server.tsx`, imported by the `ssr` role) and the admin entry (`admin.html`, `src/admin/main.tsx`) (ADR-0009).
- **Server:** `ssr` (Hono `:8081`) matches the path with the shared `routeOf`, runs the route's loader on the `pub_*` views as `mjk_ssr`, and renders with React 19 (`renderToReadableStream` or `prerender` [U P1c]): title, description, canonical, `hreflang`, Open Graph and JSON-LD `Museum` in the head, the content in the body.
- **Same data, same contract:** a loader returns exactly what the matching `/api/v1` GET returns (same zod contract, a test per route) under the same TanStack Query key. The dehydrated cache goes into `<script type="application/json" id="mjk-state">`; the client parses it, calls `hydrateRoot` and fetches nothing it already has (P1c).
- **Data blocks, no inline script:** `mjk-state` and the JSON-LD (`application/ld+json`) are the only `<script>` elements without `src`. Neither executes, so `script-src 'self'` holds. Both are serialised with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\u` sequences (invariant 5). The SSR test allows exactly those two types.
- **Anonymous by construction:** Caddy strips `Cookie` and `Authorization` before proxying to `ssr`, and `ssr` sets no cookie. Public HTML is byte-identical with or without a session (P1c test) and cacheable: `Cache-Control: public, max-age=0, s-maxage=60` [U P5a tunes it; Cloudflare caches HTML only through the Cache Rules of A§17.7].
- **Personal bits after hydration:** the account menu, visited badges, the wishlist button and the member's own review come from `/api/v1/me` and `/api/v1/me/museums/:slug`, in slots that keep their size (no layout shift).
- **Logged-in routes** (`/paspoort`, `/verlanglijst`, `/account`, `/inloggen`) get the app shell: one HTML for everyone, `noindex`; the SPA takes over.
- **The prefs script** (A§11): `/assets/prefs-<hash>.js`, tiny, blocking, same-origin, in `<head>`. It reads the `localStorage` flags (the ratings fold, the theme) and sets attributes on `<html>` before the first paint.
- **Hydration rules:** dates through `Intl.DateTimeFormat` in Europe/Amsterdam on both sides (F1); no `style=` in server markup (CLAUDE.md gotcha); no clock or random values during render. A hydration warning fails Playwright (P1c).
- **Errors:** an unknown route or museum → the SSR 404 page with status 404; a render failure → a plain 500 page without details, logged as a code; in the SPA an error boundary shows "Er ging iets mis: herlaad de pagina."

### 15.2 Routing and i18n

- No router library: `routeOf(pathname)` in `apps/web/src/lib/routes.ts`, shared by `ssr` and the client, plus `history.pushState`. Links are real `<a href>`s; only a plain left click navigates in place (F1).
- Paraglide 2.29.1 (ADR-0013): NL at `/`, EN under `/en/`. The locale comes from the URL only: no cookie and no `Accept-Language` redirect. Every page links its other language and carries an nl/en `hreflang` pair plus `x-default` (NL). `check-i18n` keeps `messages/{nl,en}.json` in step. Reviews show in the language they were written in.
- Museum slugs are the same in both languages (name and place, stable; an old slug answers 301 through `pub_slug_redirect`, P1b). The English path segments are [U P1c: the owner confirms them].

| NL | EN [U] | Page | Rendered | Indexed (from P5b) |
|---|---|---|---|---|
| `/` | `/en/` | home: search, map teaser, recent reviews | SSR | yes |
| `/musea` | `/en/museums` | list with filters (state in the query string) | SSR | yes |
| `/musea/<slug>` | `/en/museums/<slug>` | museum page | SSR | yes |
| `/musea/<slug>/reviews` | `/en/museums/<slug>/reviews` | all reviews of a museum, paged | SSR | yes |
| `/reviews/<id>` | `/en/reviews/<id>` | one review | SSR | yes |
| `/provincie/<slug>` | `/en/province/<slug>` | museums per province | SSR | yes |
| `/kaart` | `/en/map` | the map (A§15.3) and its list | SSR + lazy chunk | yes |
| `/zoeken` | `/en/search` | results for `?q=` | SSR | `noindex, follow` |
| `/u/<handle>` | `/en/u/<handle>` | public profile | SSR | yes [U P2c: or only when the member opts in] |
| `/paspoort` | `/en/passport` | progress, visits, € saved, import | app shell | no |
| `/verlanglijst` | `/en/wishlist` | wishlist | app shell | no |
| `/account` | `/en/account` | settings, sessions, passkeys, export, deletion | app shell | no |
| `/inloggen` | `/en/sign-in` | sign in; sign up with an invite | app shell | no |
| `/privacy` · `/voorwaarden` · `/contact` | `/en/privacy` · `/en/terms` · `/en/contact` | legal pages (A§13) | SSR | yes |
| `/hoe-wij-reviews-controleren` | `/en/how-we-check-reviews` | A§11 | SSR | yes |
| `/melden` | `/en/report` | the notice form, `?item=` filled from "Meld inhoud" | SSR + form | no |

- An invite link carries its code in the fragment (`/inloggen#uitnodiging=<code>`), which never reaches a server or a log.
- `sitemap.xml` (both languages: home, lists, provinces, museums, reviews, and profiles per the [U] above) and `robots.txt` (names the sitemap from P5a). The admin SPA uses the same messages.

### 15.3 Map

- maplibre-gl 6.15.0 and pmtiles 4.5.0 in a lazy chunk, loaded only on `/kaart`; a museum page links to the map instead of embedding one. The worker URL comes from Vite's `?worker&url` through `setWorkerUrl()`: same origin, `worker-src 'self'`, no `blob:` (Waterheight ADR-0016).
- **Tiles:** a Protomaps extract of the Netherlands (bbox and zooms [U P1d], ~1–2 GB [U]) made by the quarterly worker job with `go-pmtiles extract` into `/srv/mjk/tiles-build` (A§17.1, emptied after the upload), uploaded with the own SigV4 client (built in P1d with `r2_media_rw`; a single PUT up to R2's limit [U] or multipart) as `media.<domain>/tiles/nl-<build>.pmtiles` (immutable). A small `tiles/current.json` with a short cache names the file in use; the previous file stays for rollback [U P1d]. The browser reads it with range requests (`connect-src https://media.<domain>`; R2's CORS allows `GET` from `https://<domain>` only). Cold-miss `Range` behaviour on R2's custom domain is [U P1d] (ADR-0014).
- **Style:** generated from `@protomaps/basemaps` 5.7.2 by `scripts/build-map-style.ts`, validated against the style spec 26.4.4, committed, one per language (`name:nl` / `name:en`). Glyphs and sprites are committed copies, served by Caddy under `/map/*` (immutable). Attribution "© OpenStreetMap contributors · Protomaps"; the pmtiles protocol runs with `metadata: false`, because MapLibre's attribution control renders HTML.
- **Museum points:** `GET /api/v1/museums/points` as a GeoJSON source with MapLibre's clustering. Museumkaart museums differ by colour and shape (never colour alone); members also see visited and wishlist markers (P2c). Tap a point → a card → the page. The list filters apply to the map.
- **Near me:** only on a button press, through the browser's Geolocation API. The position is rounded to 3 decimals [U P1d] before `GET /api/v1/museums/near` and is never stored or logged. Denied or unavailable → a message and the list. `Permissions-Policy` allows geolocation for our origin only (A§15.6).
- **Not the only way:** every map view has the same museums as a list reachable by keyboard (WCAG 2.5.7). `prefers-reduced-motion` turns off fly-to animations.
- CI renders the map on fixture tiles from the S3 stand-in with headless WebGL2 (SwiftShader in Chromium, Mesa in WebKit; Waterheight ADR-0016).

### 15.4 PWA (P5a)

- `manifest.webmanifest`: the name from `MJK_BRAND_NAME`, `lang` nl, `start_url` `/`, `display: standalone`, theme colours, self-hosted icons (including maskable).
- Service worker `/sw.js` (same origin, scope `/`, `worker-src 'self'`): precaches the app shell and the hashed `/assets/*` of its own build. Navigations go network-first, with the shell as the offline fallback ("Je bent offline"). It never caches an `/api` answer, a personal page or media (the HTTP cache handles media).
- A new worker waits; a banner offers a reload. Signing out clears the worker's caches and the outbox below.
- **Offline "log a visit" queue [U P5a]:** a visit logged offline (museum, date, note) waits in an IndexedDB outbox on the device and is posted to `POST /api/v1/me/visits` once online (the `online` event or the next start; Background Sync is Chromium-only). A 409 (already logged) drops it. PHASES P5a builds the shell; P5a decides whether the queue ships.
- No push notifications: they need a third-party push service.

### 15.5 Design and accessibility

- **Phone first:** designed at 390 px wide; nothing scrolls sideways (tables scroll inside `.scroll`); tap targets ≥ 44 px; one column on phones.
- **Themes:** light and dark tokens on `:root` in `apps/web/src/styles.css`, following `prefers-color-scheme`, with a manual choice in `localStorage` applied by the prefs script (no flash). `contrast.test.ts`: text tokens ≥ 4.5:1, large text and UI parts (borders, focus ring, stars, map markers) ≥ 3:1, both themes.
- Colour is never the only cue: the Museumkaart status has an icon and a word; stars carry their number as text ("4 van 5").
- No font or icon files: the system font stack; icons are inline SVG components without `style` attributes.
- **WCAG 2.2 AA** is the target (good practice: the EAA does not reach a non-commercial site [U A9]): focus visible and not hidden by the sticky header (2.4.11), targets ≥ 24 px (2.5.8; we use 44), an alternative to dragging the map (2.5.7), no cognitive test at sign-in (3.3.8: ALTCHA is proof of work without a puzzle, codes can be pasted, passkeys), help in the same place on every page (3.2.6: the footer's contact link), no re-entry within a flow (3.3.7).
- Forms: visible labels; errors as text tied with `aria-describedby`; the star rating is a radio group. A photo without alt text gets a generated one ("Foto bij <museum> door <handle>").
- Checked by `@axe-core/playwright` 4.14.0 on every page template, NL and EN, light and dark, keyboard-only flows, and the owner's VoiceOver spot check (P5a).

### 15.6 CSP and security headers

Public host `<domain>`, set by Caddy on every response (error responses included: routes use their own `respond`, and `handle_errors` repeats the headers on Caddy's error path, A§17.2; CLAUDE.md gotcha):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://media.<domain>; media-src https://media.<domain>; connect-src 'self' https://media.<domain>; worker-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

- `img-src data:` serves only the SVG icons in MapLibre's CSS: without it every Waterheight map spec failed (Waterheight ADR-0016; our ADR-0009). The build test still fails on any other `data:` or `blob:` URL.
- `connect-src https://media.<domain>` is for the PMTiles range requests; `media-src` for video from P7 (harmless before).
- Never `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'`, `blob:` or a third-party host: Zod runs `jitless`, React sets styles only through the CSSOM, ALTCHA uses its `/dist/external` build, MapLibre a same-origin worker. A change needs an ADR (invariant 4).
- Other headers:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` (preload [U] once the brand is final; Waterheight ADR-0020)
  - `X-Content-Type-Options: nosniff` · `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()`
  - `Cross-Origin-Opener-Policy: same-origin` · `Cross-Origin-Resource-Policy: same-origin`
  - `X-Robots-Tag: noindex` on every response until P5b (prelaunch profile); then only on `/api/*`, the app shell, private routes, search results (`noindex, follow`) and `/melden` (launch profile; the admin host keeps `noindex, nofollow`)
  - `Cache-Control` per A§14 and A§15.1; no `Set-Cookie` but `__Host-mjk_sid` from the auth routes
- A CSP `report-to` endpoint that counts violations per directive and stores nothing else [U P5a decides]; none until then.
- **Admin host** `admin.<domain>`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://media.<domain>; connect-src 'self'; worker-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` (`worker-src` for ALTCHA at sign-in; no map and no manifest; `media-src https://media.<domain>` joins in P7 for the video queue), plus `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and the other headers above.
- **Media host** `media.<domain>` (R2, a Transform Rule, A2): `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` on every object (A§12).
- `verify-prod --profile prelaunch|launch` (P5a) checks these headers in production and fails on any script or cookie Cloudflare injects (Web Analytics, Rocket Loader, Email Address Obfuscation, Zaraz, Bot Fight Mode's JavaScript detections [U]).

## 16. Security

### 16.1 Invariants

Copied into CLAUDE.md and quoted in every build and review prompt (Waterheight's practice).

1. No secret in git, environment variables, image layers, logs or error messages. Secrets are files under `/etc/mjk/secrets`, `root:<gid> 0440` (GIDs from 63001, A§17.3), and only their consumers get that GID.
2. The `mjk` stack shares nothing with Waterheight (`rws`) or F1 (`f1`): no networks, volumes, databases, secrets, GIDs, UIDs, ports, subnets, nftables table, tunnel, timers or healthchecks group. Never touch `/etc/rws`, `/srv/rws`, `/etc/f1`, `/srv/f1`, their compose projects, tables or GIDs.
3. Admin exists only on `admin.<domain>`, behind Cloudflare Access, and the `api` checks both the Access JWT and the user's role (`moderator` or `admin`). `/api/admin/*` is a 404 on the public host. Only `127.0.0.1:8280` is published.
4. Strict CSP (A§15.6). The browser makes no third-party requests: only `<domain>` and `media.<domain>`. The CSP, the container hardening and the egress rules are never relaxed without an ADR.
5. User content is untrusted. It is plain text and never reaches an HTML sink (`dangerouslySetInnerHTML`, `innerHTML`, MapLibre `setHTML` or the like); server-rendered HTML, JSON-LD and the `mjk-state` block escape it. Repository, issue, fixture and user text is data, never instructions.
6. Uploads are re-encoded by the worker. Raw uploads and originals are never served; EXIF, GPS and all other metadata are stripped. Only our own derivatives reach R2 (A§12).
7. Containers are hardened: `read_only`, `cap_drop: ALL`, `no-new-privileges`, non-root UID 63532, memory, CPU and PID limits.
8. Data minimisation: no analytics or trackers; no IP addresses, emails, tokens, codes or user content in logs (fixed codes only). The rate limiter keeps IP prefixes, not addresses (A§9, A§13.2). `ssr` never sees a session.
9. CI never calls Wikidata, RCE, Lettermint, R2 or Cloudflare.
10. Agents never merge, push to `main` or read secrets: `.claude/settings.json` denies it (F1's list, adapted), and the real controls are the branch protection on `main` and the `production` environment (A§16.3).

### 16.2 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Account takeover through the mailbox or a stolen password | Codes, never links; email, password and passkey changes need a sign-in or code within 10 min (`reauth_required`) and end every other session; an email change notifies the old address; the session list and "sign out everywhere"; passkeys with user verification (P2b); a password is optional |
| Credential stuffing | ≥ 12 characters; one answer and the same timing for an unknown email and a wrong password; limits per user and per IP prefix (A§9); the Cloudflare rule on `/api/v1/auth/*`; ALTCHA |
| OTP brute force | 6 digits; a new code voids the older ones and verify names the purpose; 5 attempts per code and 20 codes a day per email: at most 100 guesses a day per email against 10⁶; 30 failed checks an hour per IP prefix (its /48 at 4× for IPv6); above 500 failures an hour site-wide every check also costs an ALTCHA solution [U]; single use, 10 min; stored as an HMAC with a pepper |
| Email enumeration | Sign-up and code requests answer 202 whatever the email, in the same time |
| Session theft | `__Host-` cookie, `HttpOnly`, `Secure`, host-only (never sent to `media.<domain>` or the other host); only sha256(token) stored; 30-day sliding expiry, 180 days absolute, admin host 12 h idle and 7 days absolute [U]; a new token at every sign-in; bans and sign-out delete rows; no token in a URL or log |
| CSRF | `SameSite=Lax`, our Origin / `Sec-Fetch-Site` check on every unsafe method, JSON-only bodies (415), no CORS (A§14) |
| XSS through reviews, names or handles | Plain text rendered as text nodes; no HTML sink (invariant 5); escaped data blocks; a strict CSP without inline script behind it; hostile-string fixtures in SSR and SPA tests (P1c, P3a) |
| Malicious uploads: polyglots, SVG or HTML, decompression bombs | Magic bytes (JPEG, PNG, WebP only); `limitInputPixels` ≈ 50 MP; one sharp job at a time inside a 768m limit; re-encoding, so no uploaded byte is served; random keys; `nosniff` and a `sandbox` CSP on the media host |
| SSRF | None by design: no route fetches a URL a user gives. The worker fetches only fixed hosts (Wikidata, RCE, Protomaps, Lettermint, R2), and private ranges are dropped anyway (A§17.4) |
| SQL injection | Kysely with bound parameters only, no SQL built from strings; least-privilege logins (A§8) |
| IDOR | A `self` check on every route, 404 for another member's private row; an authorization test per route (A§18) |
| Personal data in a shared cache | Public routes and `ssr` never read the session (Caddy strips `Cookie` towards `ssr`); `/me*` is `private, no-store`; Cache Rules that honour the origin's `Cache-Control` and exclude personal routes (A§17.7); the byte-identical HTML test |
| Spam and abuse | Invite-only beta; a verified email before any content; ALTCHA and a honeypot; per-user limits (A§9); bans; the photo queue for untrusted members |
| Illegal content, CSAM | The photo queue (D9); Cloudflare's CSAM Scanning Tool on the zone [U covers the R2 domain]; `blocked_hash`; notice and action with statements of reasons; runbooks (A§13.1, A§17.7) |
| Doxxing through photos | All metadata stripped (GPS included); the "no recognisable people" checkbox; the queue; privacy as a notice category; fast removal and an edge purge |
| Scraping | Public data is public anyway; nothing private without a session; no bulk route for others' data; at most 50 items a page; the edge cache absorbs repeats [U: a Cloudflare rule if it becomes load] |
| DoS on uploads | Quotas at create, before any byte; 8 MiB chunks checked for index and length before writing, never past the declared size; at most 3 open uploads per member and 2 GB [U] declared in total; Caddy body caps; unfinished uploads purged after 24 h; the disk guard (A§17.7); a 120 s [U] timeout per photo job; the worker's memory limit |
| Compromised dependency | Exact pins, the 7-day release age, `strictDepBuilds`, `blockExoticSubdeps`, Dependabot cooldown, an ADR-lite line per new dependency; few dependencies (own auth and SigV4, no AWS SDK); distroless runtime; egress per role (A§17.4) |
| Compromised admin account or device | Access (owner email + one-time PIN) and an admin-host session and the role and the matching email (D22); the Access application on the whole hostname with 24 h sessions [U A2]; every request on the admin host, the auth routes included, needs the Access JWT (A§9); every action in the INSERT-only `audit_log`; moderators cannot change roles |
| Compromised `api` process | It holds no R2 key, tunnel token or backup password (not mounted, not in its GIDs) and cannot read approved originals (a pending photo's original sits in the quarantine it writes to); it can read export bundles (copies of originals) for up to 7 days (A§17.1); its only egress is Cloudflare's ranges, but `cf4` and DNS still reach any Cloudflare-fronted host, so this egress limits reach, not exfiltration (accepted, as in F1); `mjk_api` cannot change `audit_log` |
| Compromised `worker` (a libvips exploit in an uploaded image) | Magic bytes and `limitInputPixels` before decode; one job at a time inside 768m; the P3b security review decides whether decoding moves to a role with no secrets and no egress (the P7 `mjk-media` pattern: quarantine in, variants out, the worker uploads) or records the accepted risk [U P3b]; worker egress narrowed to sets in P3b (A§17.4) |
| Cloudflare as a root of trust | It ends TLS, sees every request and could alter any answer: accepted, and named first on the privacy page (Waterheight ADR-0021). The account uses hardware-key 2FA [U owner] and per-bucket R2 tokens, with no account-wide token on the VM (A§17.3); `verify-prod` watches for injected scripts and cookies |
| Cross-project breakout to or from `rws` and `f1` | Own networks, subnets, UID, GIDs, secrets, table, volumes and units (invariant 2); the `hardening` test refuses `rws` and `f1` names; `mjk-install` refuses overlapping subnets and leaves the other projects untouched (P1e) |

### 16.3 Agents and CI

- **`.claude/settings.json`** (P0): F1's deny list with `mjk` paths: reads of `.env*`, `secrets/`, `*.secret`, `//etc/mjk/secrets/**` (and the `rws` and `f1` secret paths), `*.pem`, `*.key`, `.npmrc`, `~/.ssh`, `~/.config/gh`; the GitHub MCP tools that merge or write commits (`mcp__github__merge_pull_request`, `mcp__github__enable_pr_auto_merge`, `mcp__github__push_files`, `mcp__github__create_or_update_file`, `mcp__github__delete_file`); the force, mirror and delete push forms; every `git push` form that names `main`, and a bare `git push`; `git … --output=` and `git … --no-index`; `gh pr merge`; `gh api`, `gh auth` and `gh alias` outright (agents search with `gh search`); `gh repo edit` and `delete`; `gh secret`; `pnpm dlx` and `exec`, `pnpx`, `npx`; `npm`, `yarn`, `yarnpkg`, `corepack`, `bun` and `bunx`. This list is the one source: CLAUDE.md and PHASES P0 refer to it, and a P0 test asserts every pattern is present in `.claude/settings.json`. Defence in depth: the real controls are below.
- **Trust anchors:** the lockfile, the hand-kept sha256 pins of binaries (dbmate, go-pmtiles, restic's source; Dependabot does not bump them) and the required checks, which a PR itself defines. A diff under `.github/`, `scripts/`, `deploy/`, `pnpm-workspace.yaml` or `.claude/` gets a line-by-line owner read. The owner's line-by-line read also covers what the checks execute or obey: the `package.json` scripts, `vitest.config.ts`, `test/msw.setup.ts`, `biome.json`, `tsconfig*.json`, `.gitleaks.toml` and `.gitleaksignore`, and any `gitleaks:allow` or `zizmor: ignore` comment.
- **`main`** (A7): branch protection requires `ci` and `security`, each pinned to the GitHub Actions source, enforced for admins; no force-push or deletion; a PR before merging (0 approvals); merge commits only. Set by the owner on 2026-11-01, before #32's merge (`app_id` 15368 for both checks).
- **Workflows:** `permissions: {}` at the top and per job only what it needs; every action pinned to a full SHA (`scripts/check-workflows.sh`); zizmor and workflow-lint; gitleaks on the full history; no caches (`package-manager-cache: false`); Dependabot with a 7-day cooldown, TypeScript ≥ 7 ignored.
- **Release** (P1e, F1 A§12.5): GHCR write access is code execution on the VM. So the `release` job runs in the environment `production` (required reviewer: the owner; branch `main`) and alone can write to GHCR (see Agent identity). GitHub holds no server credential.
- **Agent identity** (decided in P0's security review, 2026-11-01): agents run as Claude Code cloud sessions that act on GitHub as the owner's account (`mwijkhuisen`) through the Claude GitHub App and its GitHub MCP tools, and that credential can change `.github/workflows`. So GitHub cannot tell an agent's push, PR or merge from the owner's. With 0 approvals, the branch protection on `main` does not stop an agent merge once `ci` and `security` are green: the deny list in `.claude/settings.json`, including the GitHub MCP merge and file-write tools, is the only barrier to an agent merge, and `ci` and `security` prove only what the PR's own files define. Accepted for P0–P1d, where nothing is deployed and the repository holds no secret. Before P1e's `release` job first pushes to GHCR, one of these holds, and P1e's [owner] criterion checks it: (1) the agent credential cannot change `.github/workflows`: the Workflows permission is removed, or, if the Claude GitHub App cannot drop it for this repository, agents push with a fine-grained token without the Administration and Workflows permissions, as F1 did; or (2) GHCR write never comes from a `GITHUB_TOKEN` that a branch's workflow can request: the packages give this repository's Actions read access only, and the `release` job pushes with a `write:packages` credential held only as a `production` environment secret. The owner pushes every diff under `.github/workflows`, and confirms once in the Claude GitHub App's installation settings that it holds no Administration permission.
- **CI egress** (CI only): registry.npmjs.org, GitHub (release assets, api.github.com for zizmor), nodejs.org, Docker Hub, gcr.io, ghcr.io, cgr.dev (Chainguard MinIO), mcr.microsoft.com (the Playwright image), deb.debian.org and the Ubuntu archive. Production gains no host from it.
- **F1's accepted risks** (F1 A§12.4), settled in P0's security review:
  - **`git diff|log|show *` with `--output=`: not confirmed.** `git log --format=<text> --output=<path>` writes any content to any path without a prompt, and through `.git/config` (`core.fsmonitor`) the allow-listed `git status` then runs it, so `Bash(git *--output*)` is denied. Claude Code checks deny rules before allow rules, so the read-only `git diff *`, `git log *` and `git show *` allow rules stay (owner, 2026-11-01).
  - **`npm`, `yarn` and `bunx`: not confirmed.** All of them, and `bun`, are installed in the agent sandbox and run registry code outside the pnpm policy, so they are denied.
  - **SHA pinning enforced only by files a PR can change: confirmed.** At A7 the owner turned on the Actions policy "Require actions to be pinned to a full-length commit SHA" (`sha_pinning_required: true`) and allows only `actions/checkout` and `actions/setup-node` (`allowed_actions: selected`; owner, 2026-11-01). A new action needs that list changed by the owner, next to the line-by-line read of `.github/`.

## 17. Deployment

### 17.1 Host and sizing

- The Waterheight Hyper-V VM (Debian 13 amd64), shared with Waterheight (`rws`) and F1 (`f1`): today 6 vCPU / 12 GB (D11). Proposed **8 vCPU / 16 GB** (A3) [U, measured after P1e and after the beta].
- Disk: 1 TB with 960 GB free on 2026-10-25 (F1 A§14.1) [U today]. Year one: originals ~50 GB [U, the media research's estimate with video], the database under 1 GB [U], ~2 GB in `tiles-build` while a tiles build runs, one night's dump in `backup-staging`.
- Compose project `mjk`, installed as `/etc/mjk/compose.yaml` by `mjk-install`. Paths `/etc/mjk/{mjk.env, secrets/, postgres/roles.sql}`, `/srv/mjk/{state, originals, quarantine, exports, tiles-build, backup-staging}`, volume `mjk_pgdata`.
- Every container runs as 63532, so separation between them is by mount (the containers are `read_only` and their tmpfs `/tmp` counts against memory, so large files go here):

  | Path | Owner, mode | Mounted in |
  |---|---|---|
  | `/srv/mjk/quarantine` | 63532, 0700 | `api` (rw), `worker` (rw) |
  | `/srv/mjk/originals` | 63532, 0700 | `worker` (rw), `backup` (ro) |
  | `/srv/mjk/exports` | 63532, 0700 | `worker` (rw), `api` (ro); bundles deleted after 7 days |
  | `/srv/mjk/tiles-build` | 63532, 0700 | `worker` (rw); emptied after the upload |
  | `/srv/mjk/backup-staging` | 63532, 0700 | `backup` (rw) |
  | `/srv/mjk/state` | root, 0755 | host scripts only; `disk` read-only in `api` for the disk guard [U] |

### 17.2 Services (limits [U], tuned after P1e, the beta and the launch week)

| Service | Image | mem / cpus | Networks |
|---|---|---|---|
| `db` | `postgres:18.6-trixie` | 1g / 1.0 (`shared_buffers=256MB`, `max_connections=40` [U]) | `mjk-db` |
| `api` | mjk-server `api` | 384m / 1.0 | `mjk-edge`, `mjk-db`, `mjk-api-egress` |
| `ssr` | mjk-server `ssr` | 384m / 1.0 | `mjk-edge`, `mjk-db` |
| `worker` | mjk-server `worker` | 768m / 1.0 (sharp, one media job at a time) | `mjk-egress`, `mjk-db` |
| `caddy` | mjk-web | 128m / 0.5 | `mjk-edge`, `mjk-tunnel-edge`, `mjk-publish` |
| `cloudflared` | `cloudflare/cloudflared:2026.10.3` | 256m / 0.5 | `mjk-tunnel`, `mjk-tunnel-edge` |
| `migrate` | mjk-server `migrate` (profile `jobs`) | 256m / 0.5 | `mjk-db` |
| `backup` | mjk-server `backup` (profile `jobs`, run by `mjk-backup.timer`; own stage [U]) | 256m / 0.5 | `mjk-db`, `mjk-backup-egress` |
| `sync-museums`, `admin` | mjk-server (profile `jobs`) | as `worker` / as `api` | as `worker` / `mjk-db`; secret GIDs per A§17.3 |
| `media` (P7) | `ghcr.io/mwijkhuisen/mjk-media` | 1.5g / 2.0 [U] | `mjk-db` (no egress; the worker uploads its output; own login and GIDs from 63014) |

- Total limits ≈ 2.9 GB for the six daemons, ≈ 3.4 GB with both jobs running. Expected steady state ≈ 1.2 GB [U] (F1: 2.7 GB of limits, ~0.9 GB steady). Images are A§4's pins, by digest, each re-checked against the 7-day rule when installed.
- Every service gets the hardening anchor (`read_only`, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`, `restart: unless-stopped`), a `pids_limit` and UID 63532; the Node roles have the heartbeat healthcheck (`node … healthcheck`, no shell in distroless).
- `db` runs as 63532 on `mjk_pgdata` (F1's pattern: initdb as any UID on a new volume, `roles.sql` through `docker-entrypoint-initdb.d`, local socket `trust` inside the container only, TCP `scram-sha-256`, healthcheck `pg_isready -U postgres`). `max_notify_queue_pages=64`: the job queue's NOTIFY payloads are ids. `log_error_verbosity=terse` and `log_min_error_statement=panic`, so a constraint error never writes a value such as an email to the log. Proven in P0 for constraint errors: a unique or check violation logs only its constraint name, with no DETAIL and no STATEMENT line (`apps/server/test/pg-log.int.test.ts`). But a type-input error (SQLSTATE 22P02, e.g. `invalid input syntax for type integer: "…"`) still quotes the value in its primary message under any setting. So the `api` validates every input with its zod contract before it reaches SQL, and no query casts raw user text (`$1::int`, `$1::uuid`). The others start on `db: service_healthy`.
- `cloudflared`: `--token-file`, `--no-autoupdate`, metrics on `127.0.0.1:20241`, the fixed address `10.63.6.10` on `mjk-tunnel-edge`; both public hostnames go to `caddy:80` (ADR-0004).
- `caddy`: one plain `:80` server (TLS ends at Cloudflare's edge) with host matchers for `<domain>` and `admin.<domain>`; the client IP only from `10.63.6.10/32` (`trusted_proxies_strict`); body caps per route (A§14); `Cookie` and `Authorization` stripped towards `ssr`; a short `lb_try_duration` [U] so a restart during a deploy is a pause, not a 502; tmpfs `/data` and `/config`; `net.ipv4.ip_unprivileged_port_start=80`; the image's file capability stripped. Also:
  - caddy has the fixed address `10.63.2.10` on `mjk-edge`
  - a request with `X-Forwarded-Proto: http` → a `no-store` 308 to `https://`
  - any `Host` other than `<domain>` and `admin.<domain>` → 421 (Waterheight ADR-0021 §4)
  - towards `api`, Caddy sets `X-Mjk-Client` to `{client_ip}` and removes `X-Forwarded-For`, `CF-Connecting-IP` and `True-Client-IP` (A§9)
  - `handle_errors` sets `Cache-Control: no-store` and repeats the host's A§15.6 headers (CSP, HSTS, `nosniff`, `Referrer-Policy`, `X-Robots-Tag`) on Caddy's own error responses (413, 502, `file_server` 404)
- **Keep-alive behind Caddy** [U P1e]: the `api` keeps an idle connection for `keepAliveTimeout = 65 s` (`headersTimeout = 66 s`, `apps/server/src/api/server.ts`), so Caddy, never Node, closes an idle upstream connection, and Caddy's `reverse_proxy` upstream keep-alive must stay below 65 s (its transport default of 2 minutes would race Node's close and give 502s that no `api` log shows). A drain closes each connection as soon as it is idle. P1e sets Caddy's value and proves the pair.
- Measured into this section: a day of `docker stats` (P1e), a 24 MP photo's time and peak memory (P3b), the beta (P4), the launch week (P5b), a 60 s clip (P7).

### 17.3 Networks, IDs and secrets

| Network | Subnet | Internal | Members | Egress (A§17.4) |
|---|---|---|---|---|
| `mjk-db` | 10.63.1.0/24 | yes | db, api, ssr, worker, migrate, backup, sync-museums, admin | – |
| `mjk-edge` | 10.63.2.0/24 | yes | caddy (10.63.2.10), api, ssr | – |
| `mjk-egress` | 10.63.3.0/24 | no | worker, sync-museums | tcp/443, internet minus private ranges; sets from P3b |
| `mjk-api-egress` | 10.63.4.0/24 | no | api | tcp/443 to `cf4` |
| `mjk-tunnel` | 10.63.5.0/24 | no | cloudflared | tcp+udp/7844 to `cf_tunnel4` |
| `mjk-tunnel-edge` | 10.63.6.0/24 | yes | cloudflared (10.63.6.10), caddy | – |
| `mjk-publish` | 10.63.7.0/24 | no | caddy | none; carries the `127.0.0.1:8280` publish |
| `mjk-backup-egress` | 10.63.8.0/24 | no | backup | tcp/443 to `cf4` |

- Bridges named `mjk-*`, IPv4 only, `enable_icc: false` on the five non-internal ones. Every container has at most one non-internal network, so its default route is unambiguous; `ssr` has none. `mjk-install` refuses a subnet that overlaps a host route or a non-`mjk` Docker network (F1's 10.62.x, Waterheight's 172.30.0.0/16, the LAN).
- **IDs:** UID 63532 (F1 62532, Waterheight 65532/65533); secret GIDs 63001–63013 through `group_add`, 63014 and up reserved for P7; the only published port is `127.0.0.1:8280` (F1 8180).

| Secret (`/etc/mjk/secrets`, `root:<gid> 0440`) | GID | Consumers |
|---|---|---|
| `db_postgres` | 63001 | db |
| `db_mjk_migrator` | 63002 | db, migrate |
| `db_mjk_api` | 63003 | db, api, admin |
| `db_mjk_ssr` | 63004 | db, ssr |
| `db_mjk_worker` | 63005 | db, worker, sync-museums |
| `db_mjk_backup` | 63006 | db, backup |
| `cf_tunnel_token` | 63007 | cloudflared |
| `lettermint_api_token` | 63008 | worker |
| `r2_media_rw` (S3 key id + secret; Object R/W on `mjk-media` only) | 63009 | worker |
| `r2_backup_put` (S3 key id + secret; Object R/W on `mjk-backup` only; the lock rule protects history, A§17.6) | 63010 | backup |
| `restic_password` | 63011 | backup |
| `app_keys` (OTP pepper, invite pepper, code sealing key, ALTCHA HMAC, export link signing, statement-of-reasons/appeal reference signing; P6a unsubscribe signing) | 63012 | api, worker, admin |
| `hc_ping_key` | 63013 | worker, backup |

- `db` holds the login GIDs because `roles.sql` sets their passwords with `pg_read_file` (F1).
- **Config, not secrets** (`/etc/mjk/mjk.env`, a Compose `env_file`): `MJK_BRAND_NAME`, `MJK_DOMAIN`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, the R2 account id, endpoint and bucket names, the sender address, `MJK_MAIL_CAP` (the mail plan's monthly cap, A§17.7), `MJK_SIGNUP` (`invite` · `open`), `MJK_PROFILE` (`prelaunch` · `launch`). A missing or malformed value → the role logs the variable's name and exits 78 (F1). Compose never sets `DATABASE_URL` (the `hardening` test checks it).
- Rotation per secret in `docs/runbooks/secrets-rotation.md`; a new `app_keys` pepper invalidates only pending codes or unused invites [U overlap window].

### 17.4 Firewall

- A separate `table inet mjk`, loaded by `mjk-firewall.service` (oneshot, `nft -c` then `nft -f`, never `flush ruleset`). Forward hook on `mjk-*` interfaces only:
  - DNS from the four egress networks (`mjk-egress`, `mjk-api-egress`, `mjk-tunnel`, `mjk-backup-egress`) to `resolvers4`, before the drop of private ranges (the resolvers may be on the LAN)
  - tcp/443 from `mjk-egress` (worker) to anything but private ranges (to the sets below from P3b)
  - tcp/443 from `mjk-api-egress` (the Access certs) and `mjk-backup-egress` (R2) to `cf4` [U R2's S3 endpoint is inside `cf4`; P1e proves it]
  - tcp+udp/7844 from `mjk-tunnel` to `cf_tunnel4`
  - drop everything else, all of `mjk-publish`'s egress included, plus host-input drops for `mjk-*` (only established/related replies pass: docker-proxy's path for 8280)
- Private ranges are dropped even on 443. Traffic between two `mjk-*` bridges is `return`ed to Docker's own rules.
- Sets: `cf4` from `https://www.cloudflare.com/ips-v4`; `cf_tunnel4` = 198.41.192.0/24 and 198.41.200.0/24 (Cloudflare's "Tunnel with firewall" page); `resolvers4`, filled by `mjk-resolvers` from the host's resolv.conf at start and on every `mjk-tick`. The owner refreshes `cf4` and `cf_tunnel4` by hand (`docs/runbooks/cloudflare.md`).
- `table inet rws` and `table inet f1` match only their own bridges: without this table the stack's egress would be open.
- Health pings: from `worker` over `mjk-egress`; from `backup` only if hc-ping.com sits inside `cf4` [U A8], else the `mjk-backup` unit pings from the host after a successful run.
- P3b narrows the worker's egress to sets (Wikidata, RCE, Lettermint's IPs, the Protomaps build host, R2, hc-ping, and `commons.wikimedia.org` and `upload.wikimedia.org` for the Commons images, ADR-0018) [U the set sources].

### 17.5 Updates

- CI on `main` (the `release` job, environment `production`, the owner approves) builds `ghcr.io/mwijkhuisen/mjk-server` and `mjk-web`, pushes `:main` and `:sha-<git>` (public, no secrets inside) and records the digests; its `concurrency` group queues runs without cancelling them.
- `mjk-update.timer` (every 10 min) runs `deploy/bin/mjk-update`:
  1. take a flock; refuse (exit 1) when `table inet mjk` is not loaded
  2. pull `:main`; wait (exit 0) while the two images' `org.opencontainers.image.revision` labels differ; stop if the digests equal `current.env`; stop with a loud log line if the pair equals `failed.env` (`rm /srv/mjk/state/failed.env` to retry)
  3. run `migrate`
  4. `up -d`
  5. smoke-test `http://127.0.0.1:8280/api/v1/healthz` and one museum page, both with `Host: <domain>` (A§17.2 answers any other `Host` with 421), then require every `mjk` container healthy
  6. on failure, write the pair to `failed.env` and roll back to the digests in `/srv/mjk/state/current.env`
- **A migration must work with the previous image** (expand now, contract in a later release): a rollback restores the old images but never runs `down`. The PR template asks for it.
- `mjk-update --server <ref> --web <ref>` deploys given images (drills, CI); a ref with a registry host is recorded by digest, so `current.env` never names a movable tag.
- Compose, Caddyfile, nftables and units change rarely: the owner applies them with `deploy/bin/mjk-install` from a checkout on the VM. It is idempotent, leaves `rws` and `f1` untouched, and does not enable the timers until the secrets and `mjk.env` are filled (`docs/runbooks/install.md`). The timers run root-owned copies in `/usr/local/bin`, never a file of the checkout (F1 A§12.5).
- GitHub has no server credentials.

### 17.6 Backups and restore

- **Nightly** `mjk-backup.timer` [U time, away from Waterheight's and F1's jobs] runs the `backup` role (ADR-0011, D24): `pg_dump -Fc --exclude-table-data` for `session`, `email_code`, `auth_challenge`, `rate_limit` and `job` (a restore signs everyone out) as `mjk_backup` into `/srv/mjk/backup-staging`, then restic 0.19.1 of the dump and `/srv/mjk/originals` to the private R2 EU bucket `mjk-backup`, then the local dump is deleted and healthchecks is pinged.
- **Lock:** a bucket lock rule on `mjk-backup` keeps objects under `data/`, `index/`, `snapshots/`, `keys/` and `config` for 28 days [U]. `locks/` is left out so restic can remove its own lock files [U P1e]. R2 has no put-only permission and no object versioning [U P1e], so `r2_backup_put` is an Object Read & Write token scoped to `mjk-backup` only, and the lock rule is the only thing that stops it deleting recent history. Lock rules change only with an Admin token kept in the owner's password manager, never on the VM. The first drill proves restic's behaviour under the lock (ADR-0011, Revisit).
- **Retention:** `restic forget --keep-daily 28 --prune --max-unused 0` [U P1e cost], weekly, from the owner's workstation with its own token (Object R/W on `mjk-backup`, never on the VM). No weekly or monthly snapshots, so a deleted account leaves the backups within ~35 days (A§13.2) [U].
- **Restore drill**, monthly (`docs/runbooks/restore-drill.md`): restore the latest snapshot into a throw-away database, compare row counts per table with production, restore a sample of originals and check their sha256, then re-apply the account deletions since the snapshot: from production's `audit_log` when it survives; for a full loss, from the owner's deletion notices (the deletion job mails the owner "<account id> deleted <time>", ids only) [U]. The restore runbook keeps the site in maintenance until those deletions are re-run. The owner reads the result; the status panel shows the last drill.
- **RPO** ≤ 24 h for the database and the originals. **RTO** about a day [U]: reinstall, restore, rebuild the derivatives.
- **Not backed up:** the R2 derivatives (a worker job rebuilds them from the originals [U P3b]), the basemap tiles (re-extracted), the quarantine, export bundles, `/srv/mjk/tiles-build`, `/srv/mjk/state` (rebuilt by `mjk-install` and `mjk-update`), the images (in GHCR).
- The secrets are not in the backup: the owner keeps the restic password, the workstation token, the Admin token for lock rules and the R2 keys in a password manager off the VM; without them a restore is impossible.
- Accepted risk (D24): media and backups with one vendor in one account. The originals on the VM survive losing that account; the backups survive losing the VM.

### 17.7 Operations and monitoring

- **`mjk-tick.timer`** (every 10 min, at :07; F1 runs at :05): reloads `table inet mjk` if it is missing, refreshes `resolvers4`, restarts unhealthy `mjk` containers (Docker doesn't) and records disk use in `/srv/mjk/state/disk`. Fail closed: when the table cannot be loaded it stops every `mjk` container and writes `/srv/mjk/state/firewall-stopped`; once the table loads, `mjk-tick` or `mjk-update` starts `current.env` again. It works under `mjk-update`'s lock.
- **Disk guard:** below 10 % free [U], the `api` refuses new uploads (503 `unavailable`) and the status panel turns red.
- **healthchecks.io** [U A8: the free account's checks are used up by Waterheight and F1; the owner picks a new free account or an alternative]: `mjk-worker` (pinged hourly while the queue drains, the last weekly sync is under 8 days old and the month's mails are under 80 % of `MJK_MAIL_CAP`) and `mjk-backup` (each nightly run; period 1 day, grace 2 h [U]).
- **Status panel** on the admin host (P3c): jobs per state, failed jobs with their codes, sync runs, the last backup and drill, disk, queue ages, and the mails sent this month against the plan cap.
- **Mail budget** (Lettermint's free plan is a hard cap of 300 a month, D15): sign-in codes always go first. Mails triggered by anonymous requests (notice receipts, sign-up codes) are capped at 20 a day [U]: over that, `/auth/signup` answers 429 with `Retry-After` (a queued code would expire unsent) and notice receipts wait. The counts live in `rate_limit` windows with the key `site`. At 80 % of `MJK_MAIL_CAP` the worker logs `mail_cap_near` and its health ping fails.
- **Logs:** pino JSON to Docker's `local` driver. Fixed codes and ids only: never IPs, emails, handles, tokens, codes, cookies, query strings, bodies or user text (invariant 8; the log-capture test, A§18). Caddy's access log is off; its error log carries no client address [U the Caddy fields].
- **Cloudflare** is not code: `docs/runbooks/cloudflare.md` lists every setting (the Access application, the rate-limiting rule, Cache Rules, the Transform Rule, R2 CORS, `r2.dev` off, the CSAM tool, the script injections that stay off), and `verify-prod` checks what it can (Waterheight ADR-0021).
  - Cache Rules (Waterheight ADR-0021 §8): (1) host `<domain>`, path not under `/api/` → eligible, Edge TTL "use the origin's Cache-Control; bypass if absent"; (2) host `<domain>`, GET under `/api/v1/` except `/api/v1/me`, `/api/v1/auth/`, `/api/v1/uploads` and `/api/v1/museums/near` → the same mode; (3) `media.<domain>` per A§12. Nothing on `admin.<domain>`; never "Cache Everything" or an Edge TTL that ignores the origin outside `media.<domain>`.
- **Runbooks** (`docs/runbooks/`): `install`, `update`, `cloudflare`, `backup`, `restore-drill`, `secrets-rotation`, `incident` (site down, bad deploy, full disk) (P1e); `museum-sync` (P1a); `tiles-refresh` (P1d); `art18`, `takedown-and-purge`, `csam` (P3c); `breach` (P3d, with the Art. 30 register and `processors.md` in `docs/legal/`); `launch` (P5b).

## 18. Testing

- **Unit** (Vitest 5.0.5 `unit`): the Wikidata, RCE and import parsers, the matcher, progress and € saved, the Bayesian score, the rate limiter (fake timers), SigV4 (the AWS test vectors), handle and slug rules, cursors, the header builders. fast-check for the parsers (arbitrary input → a typed error, never a throw), the matcher, the ranking (the score lies between m and the plain mean), the rate limiter and keyset paging.
- **Integration** (`*.int.test.ts`) on real PostgreSQL 18 as a CI service container: each file creates its own database with F1's `createTestDb()`, applies `roles.sql`, runs the real `migrate` role, and logs in as the role under test (`mjk_api`, `mjk_ssr`, `mjk_worker`, `mjk_backup`), never as the superuser. `pg-log.int.test.ts` reads the PostgreSQL server log through `docker logs` (CI passes the service container as `PG_LOG_CONTAINER`). Migrations up → down → up, `kysely-codegen --verify`, a sha256 pin per applied migration. Grant tests: no login can UPDATE, DELETE or TRUNCATE `audit_log`; no login can UPDATE any other `notice` column than its A§8 column grants; the purge function deletes only rows older than 3 years whatever the caller does, and its `proconfig` pins `search_path`.
- **Search plans** (P1b, `search-explain.int.test.ts`):
  - It runs `EXPLAIN` of the exact search SQL as `mjk_api` on the seeded 1,400 museums.
  - The trigram branches must use their GIN indexes with the planner's defaults.
  - The full-text branch must use `museum_search_idx` when forced at 1,400, and with the defaults on ~21,400 rows.
  - The ~21,400-row step runs `VACUUM (ANALYZE)` as `mjk_migrator` first, which flushes the GIN pending list.
- **Contracts and authorization:** every `/api/v1` and `/api/admin` answer parses against its contract; every route has an authorization table test (anonymous, member, another member, banned, terms not accepted, moderator, admin; admin routes also without a JWT, with another email and on the public host); the SSR loaders equal the API answers.
- **Privacy:** `mjk_ssr` gets permission denied on every table; private visits, notes and wishlists appear in no `pub_*` view, SSR page, sitemap or public route; public HTML and JSON are byte-identical with and without a session; a log-capture test runs the auth, upload and report flows and fails on any email, IP, token, code or body; each A§13.2 retention row is purged on time (fake clock); the deletion walk (P3d).
- **Fixtures:** recorded Wikidata SPARQL and RCE WFS answers (normal, edge, empty) from `scripts/record-fixture.ts`, which refuses under `CI`; hostile strings (`</script>`, markup, bidi controls, 5,001 characters) in museum names, handles and reviews; crafted uploads (polyglots, a 30,000 × 30,000 px PNG, truncated JPEGs, GPS EXIF, a file in `blocked_hash`).
- **msw 3** with `onUnhandledFrame: 'error'`: a request without a handler fails the test. Wikidata, RCE, Lettermint and the Access certs are handlers.
- **Web:** component tests render with `react-dom/server` in Vitest's node environment (F1). `build.test.ts` scans `dist` and the SSR output for inline scripts (the two data blocks aside), `<style>`, `style=` attributes, inline handlers, `data:` and `blob:` URLs (ADR-0009's `img-src data:` for MapLibre aside) and third-party references, and checks that MapLibre sits only in the map route's lazy chunk. `contrast.test.ts` (A§15.5); `check-i18n` in `pnpm check`.
- **E2E:** Playwright 1.64.1, Chromium and WebKit, in the Playwright CI image, against the CI compose stack (the real `caddy`, `ssr`, `api`, `worker` and `db`) with stand-ins: Chainguard MinIO for R2 (also used for restic, without a lock: MinIO's Object Lock needs versioning, so a delete adds a marker and succeeds, and it is bucket-wide, so it cannot model R2's per-prefix lock rule; the lock is proven only on the box, by P1e and the restore drill) and a mail sink that speaks Lettermint's API. Under the production CSP each spec asserts 0 `securitypolicyviolation` events and no request to a host other than `<domain>` and `media.<domain>` (their stand-ins). Passkeys run on Chromium's virtual authenticator, the map on headless WebGL2, `@axe-core/playwright` 4.14.0 on every page template (P5a).
- **Deploy** (job `ci / deploy`, from P1e): `deploy/tests/hardening.sh` (on `compose config`: the hardening anchor, UID 63532, limits, only 8280 published, no `rws` or `f1` names, subnets, GIDs or volumes, no `DATABASE_URL`), `nft-check.sh` (`nft -c` and a double load in a container, no `flush ruleset`) and `e2e.sh` (install, deploy, egress per network, rollback, `mjk-tick` reloading a deleted table).
- **Never in CI:** Wikidata, RCE, Lettermint, R2, Cloudflare, real phones. Those are [box] and [owner] criteria (PHASES §2).

## 19. Costs

Per year, in euros. [U] items are measured in P4 and written back.

| Item | Beta (M4) | Public (from P5b) | Notes |
|---|---|---|---|
| Domain `.nl` + `.com` | ≈ 20 | ≈ 20 | With WHOIS privacy (A1) [U registrar] |
| Cloudflare Free: DNS, tunnel, Access, one rate-limiting rule, CSAM Scanning Tool | 0 | 0 | |
| R2 media and tiles (EU) | 0 | 0–5 [U] | Free each month: 10 GB-month, 1M Class A and 10M Class B operations; then $0.015/GB-month, no egress fees. Year one ≈ 2.5 GB of photo derivatives + 2–4 GB of tiles (two files) |
| R2 backups (EU, locked) | 0–5 [U] | 0–5 [U] | Originals of ~50 GB [U] go past the free storage: ~40 GB × $0.015 × 12 ≈ $7 a year at the end of year one |
| Lettermint | 0 (300 a month, hard cap) | 120 (Starter, €10 a month, 10k) | D15; Starter before sign-up opens (P5a) |
| healthchecks.io | 0 [U A8] | 0 [U A8] | |
| GitHub: public repository, Actions, GHCR | 0 | 0 | |
| VM, power, home line | – | – | Shared with Waterheight and F1; A3 uses existing hardware [U] |
| One hour of Dutch legal advice (A9) | one-off [U] | – | Before P3d's sign-off |
| **Total** | **≈ 20–25, plus the legal hour** | **≈ 140–150** | |

- Video (P7) adds ~6.5 GB of derivatives in year one [U]: still near the free tier.
- Not paid for, by decision: Cloudflare Stream or Images (ADR-0008), a second backup vendor (D24), analytics, ads or anything that earns (D14).

## 20. Risks

| Risk | Mitigation |
|---|---|
| The official app shows visit history again (the Mijn Museumkaart FAQ promises it) and the passport half loses its edge | What the official side lacks: reviews by card holders tied to visits, public profiles, the web and Android, better filters, € saved (ADR-0001). If the official history becomes exportable, members upload it (never scraped) |
| Cold start: too few reviews to matter | Hand-seeded beta (A11); a rating needs no text; a review prompt right after logging a visit (P3a); bulk onboarding; importing a member's own earlier reviews with their visits (A§10); the P4 gate measures reviews per member and museums with a review |
| Trademark: "Museumkaart" is protected; a shortlisted brand collides (museumlog.app) | Neutral brand in config and messages (ADR-0006, D23); BOIP and EUIPO check before registering (A1); descriptive use only and the "not affiliated" footer; a rename touches config and messages, not code |
| Museumkaart list accuracy and data access: no feed, public counts disagree (426–539), museum.nl text and lists are off limits | The curated flag with a published list version and date (A§7.5); "Meld een wijziging"; A5 asks for a feed or permission; Wikidata and RCE only (ADR-0005) |
| Illegal content and the moderation load on one person | Invite-only beta, the photo queue, text live but reportable, the hash blocklist, the CSAM tool; the P4 gate measures hours per week before open sign-up; the moderator role for help |
| Legal uncertainty: DSA applicability, trader status, IP retention, the database right | Assume the DSA applies (cheap); no revenue ever (D14); one paid hour of advice (A9) before P3d's sign-off, its database-right question answered before A6; the [U] items of A§13 |
| Cloudflare's terms for media and tiles change, or R2's custom domain on an EU bucket misbehaves [U] | Media and tiles on R2, nothing large through the tunnel (ADR-0008, ADR-0014); P1d and P3b prove the custom domain; derivatives and tiles can be rebuilt, so a move is a rebuild, a re-upload and an ADR |
| One vendor for media and backups (D24) | Accepted; the originals also live on the VM; a locked bucket and per-bucket tokens, no account-wide token on the VM; hardware-key 2FA on the account [U] |
| Home line, power, one disk | Accepted for a hobby site (ADR-0003); RPO ≤ 24 h; the reinstall and restore runbooks; the edge cache serves public pages for up to the `s-maxage` only |
| Resource contention with Waterheight and F1 | Limits per container (A§17.2), sharp one job at a time, the VM resize (A3), measurements after P1e, P4 and P5b; video only after a measured trial (P7) |
| Dependency churn and the 7-day rule (2026 versions newer than most model knowledge) | Few dependencies; exact pins; the CLAUDE.md gotchas; Dependabot cooldown; own code where a library churns (better-auth, aws4fetch) |
| Security bugs in our own auth code | A small surface (codes, an optional password, passkeys through `@simplewebauthn`), Lucia's documented approach, the A§16.2 table as the review checklist, `review:security` on P2a and P2b, tests per criterion; admin also behind Access (D22) |
| Fast-moving small competitors (Cultra; MuseumsAtlas with its own "Museumpaspoort") | Ship the passport-first beta and own the public, web-first, review half |
| Fake, rewarded or staff reviews, and defamation claims | Terms forbid them; one review per member per museum, tied to a visit; notice and action; the email and the 30-day IP log kept for court orders (A§13.4) |

## 21. ADRs

| ADR | Decision |
|---|---|
| [0001](../adr/0001-product-scope-passport-first.md) | Product: public museum catalogue, passport-first, invite-only beta |
| [0002](../adr/0002-f1-waterheight-stack-for-a-public-multi-user-site.md) | The F1/Waterheight stack, adapted for a public multi-user site |
| [0003](../adr/0003-own-compose-project-on-the-shared-vm.md) | Own compose project `mjk` on the shared VM |
| [0004](../adr/0004-own-tunnel-and-access-gated-admin-host.md) | Own Cloudflare Tunnel; admin host behind Cloudflare Access |
| [0005](../adr/0005-museum-data-from-wikidata-and-rce.md) | Museum data from Wikidata and RCE; curated Museumkaart flag |
| [0006](../adr/0006-neutral-brand-and-code-name.md) | Neutral public brand; internal code name `mjk` |
| [0007](../adr/0007-own-authentication.md) | Own authentication: email code, password and passkeys |
| [0008](../adr/0008-media-through-the-api-served-from-r2.md) | Media: uploads through the API, derivatives served from R2 (EU) |
| [0009](../adr/0009-server-rendered-public-pages.md) | Server-rendered public pages under a strict CSP |
| [0010](../adr/0010-moderation-and-legal-by-design.md) | Moderation and legal compliance by design (DSA, GDPR, copyright) |
| [0011](../adr/0011-backups-to-a-locked-r2-bucket.md) | Backups: restic to a locked private R2 EU bucket |
| [0012](../adr/0012-transactional-email-via-lettermint.md) | Transactional email via Lettermint |
| [0013](../adr/0013-dutch-and-english-with-paraglide.md) | Dutch and English with Paraglide |
| [0014](../adr/0014-self-hosted-basemap-tiles-on-r2.md) | Self-hosted basemap with tiles on R2 |
| [0015](../adr/0015-search-and-jobs-in-postgresql.md) | Search and jobs in PostgreSQL |
| [0016](../adr/0016-non-commercial-hobby-site.md) | Non-commercial hobby site |
| [0017](../adr/0017-visit-tied-reviews-and-fair-ranking.md) | Reviews tied to a logged visit; Bayesian ranking |
| [0018](../adr/0018-wikimedia-commons-images-self-hosted-with-attribution.md) | Wikimedia Commons images, self-hosted with attribution (amends 0005) |
