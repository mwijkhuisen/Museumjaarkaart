# ADR-0014: Self-hosted basemap with tiles on R2

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The catalogue has a map with clustered museum points and "near me" (D3).
- The browser makes no third-party requests (A§16.1). Waterheight ADR-0006 self-hosts a Protomaps extract with go-pmtiles and its own glyphs and sprites; Waterheight ADR-0016 runs MapLibre under the strict CSP without `blob:`.
- Waterheight serves its tiles from its own disk. Behind a tunnel that means large range responses through Cloudflare, which the Service-Specific Terms (2026-09-28) restrict for large files not hosted on a Cloudflare service (Waterheight ADR-0021, consequences).
- R2 serves range requests on the media bucket's custom domain (ADR-0008). Cloudflare drops `Range` on a cold miss of a cacheable object (Waterheight ADR-0021); how that plays with R2's custom domain is [U P1d].

## Decision

- **maplibre-gl 6.15.0** as a lazy chunk, with **pmtiles 4.5.0**; the worker URL is set with `setWorkerUrl` (same origin, never `blob:`), as in Waterheight ADR-0016.
- **Tiles:** a Protomaps extract of the Netherlands made with go-pmtiles 1.31.2 (`pmtiles extract`, in the server image), refreshed quarterly by a worker job [U size ~1–2 GB], uploaded to the media bucket under `tiles/` and read with range requests from `media.<domain>`. The previous file stays for rollback.
- **Style:** generated from `@protomaps/basemaps` 5.7.2 (flavour `light`), checked against `@maplibre/maplibre-gl-style-spec` 26.4.4, and committed. Glyphs (Noto Sans Regular, Medium, Italic) and the `light` sprites are self-hosted in the web image under `/map/*`, copies of `protomaps/basemaps-assets` at a pinned commit with a sha256 list (owner, P1d).
- **CSP** (A§15.6): `img-src 'self' data: https://media.<domain>`, `connect-src 'self' https://media.<domain>`, `worker-src 'self'`. The bucket's CORS allows `GET` from `https://<domain>` only.
- **Attribution:** "© OpenStreetMap contributors · Protomaps", plain text with no link (owner, P1d); the pmtiles protocol runs with `metadata: false`.
- **Museum points** come from our own API, so no OSM data enters our database (ADR-0005). **Near me** uses the browser's Geolocation and SQL (ADR-0015), with no third party.
- Pins are re-checked against the 7-day rule when installed.

## Consequences

- No tile traffic passes through the tunnel or over the home line. Every tile request is an uncached R2 read (Class B: 10 million a month free, then $0.36 per million), because the file is over Cloudflare's 512 MB cache limit (amendment below); the [box] run counts one phone session [U].
- MapLibre (~1 MB plus its worker) never loads with a page's first paint.
- The quarterly refresh needs worker egress to the Protomaps build host [U] and an R2 write of the new file.
- CI needs headless WebGL2 through software renderers, as in Waterheight.
- OSM appears only inside the tiles, attributed on the map; its share-alike does not reach our tables.

## Alternatives rejected

- **OSM raster tiles or third-party tile CDNs (OpenFreeMap and the like):** third-party browser requests, and no SLA.
- **Tiles through the tunnel from the VM disk, like Waterheight:** large range responses against Cloudflare's terms, all carried by the home line.

## Amendment (P1d, 2026-11-22)

- Built in P1d as decided above, with the owner's answers to the phase's questions (`docs/plan/phases/p1d-map.md` §0.1, A§15.3): the extract is the `NL_BOX` at the build's full zoom range; `tiles/current.json` names the file in use and the previous one, which stays until the next refresh succeeds; the tile file goes up as a multipart upload; the refresh runs on the first Sunday of January, April, July and October.
- The bucket's CORS rule needs `AllowedHeaders: range` and `ExposeHeaders: ETag` besides `GET` from `https://<domain>`; pmtiles 4.5.0 sends no `If-Match`, so no `if-match`. The CI stand-in proves the browser side; the [box] run of P1d records the cold-miss and warm `Range` answers of R2's custom domain (still [U] until then).
- **Cloudflare's cache and the tile file** (Cloudflare and Protomaps docs, 2026-11-22; A§15.3): Free, Pro and Business cache objects up to 512 MB, judged by the complete size from `Content-Range`, so a 1–2 GB extract is never edge-cached and a warm range read is no `HIT` (`cf-cache-status` `DYNAMIC` or `MISS`). Without a rule `.pmtiles` is not eligible, Cloudflare passes the `Range` on and R2 answers 206, and each tile request is a billed Class B read that pays R2's latency (Protomaps warns of 500 ms or more). **Never a cache-eligible rule that covers `tiles/` while the file is over 512 MB**: on a cacheable miss Cloudflare may drop the `Range` and pull the whole file from R2 without storing it. If the map is slow on a phone over 4G, the owner chooses between accepting it, an extract under 512 MB with a Cache Rule and "Origin Range Requests" (untested), and a Worker in front, as Protomaps recommends (a new component, so a new ADR).
- **Accepted risks** (P1d reviews; A§16.2):
  - The go-pmtiles child runs with the worker's UID and groups, so a parser compromise from a hostile build (or a host that a redirect points to) could read `r2_media_rw`. Mitigations: a pinned, sha256-checked binary; the source URL built from a strict `20YYMMDD` key, never taken from the list; a fixed child environment; the header and size checks before any upload; a token with Object Read & Write on `mjk-media` only; P3b's worker egress sets. The upgrade path is a separate one-shot container with only the build directory and no secret, the worker doing the upload.
  - From P2a the worker also holds `app_keys` (all four keys) and `lettermint_api_token`, so the same compromise could read them: with `code_seal` and the `mjk_worker` login it could open pending sign-in codes and mail members from our domain. Accepted for P2a (A§16.2 "The tiles extract"); the owner's decision is open: a separate mail service, or `code_seal` as its own secret [U owner].
  - Only the header and the section bounds are checked, not the tile contents: a well-formed header over hostile tiles goes live until a rollback (about 5 minutes). A build whose date is not later than the file in use is never extracted, so a stale or hostile `builds.json` cannot roll the map back.
  - A refresh whose `current.json` PUT committed but whose answer was lost ends `tiles_up_to_date` on its retry, so the file two back stays in the bucket as an orphan (1–2 GB) that no pointer names; `docs/runbooks/tiles-refresh.md` §6 says how to find and delete one by hand. A rollback is a swap, so it runs once and is never retried (§5 of that runbook).
