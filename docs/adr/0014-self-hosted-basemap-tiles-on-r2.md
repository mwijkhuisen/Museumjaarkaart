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
- **Style:** generated from `@protomaps/basemaps` 5.7.2, checked against `@maplibre/maplibre-gl-style-spec` 26.4.4, and committed. Glyphs and sprites are self-hosted in the web image under `/map/*`.
- **CSP** (A§15.6): `img-src 'self' data: https://media.<domain>`, `connect-src 'self' https://media.<domain>`, `worker-src 'self'`. The bucket's CORS allows `GET` from `https://<domain>` only.
- **Attribution:** "© OpenStreetMap contributors · Protomaps"; the pmtiles protocol runs with `metadata: false`.
- **Museum points** come from our own API, so no OSM data enters our database (ADR-0005). **Near me** uses the browser's Geolocation and SQL (ADR-0015), with no third party.
- Pins are re-checked against the 7-day rule when installed.

## Consequences

- No tile traffic passes through the tunnel or over the home line; reads stay within R2's free tier [U].
- MapLibre (~1 MB plus its worker) never loads with a page's first paint.
- The quarterly refresh needs worker egress to the Protomaps build host [U] and an R2 write of the new file.
- CI needs headless WebGL2 through software renderers, as in Waterheight.
- OSM appears only inside the tiles, attributed on the map; its share-alike does not reach our tables.

## Alternatives rejected

- **OSM raster tiles or third-party tile CDNs (OpenFreeMap and the like):** third-party browser requests, and no SLA.
- **Tiles through the tunnel from the VM disk, like Waterheight:** large range responses against Cloudflare's terms, all carried by the home line.
