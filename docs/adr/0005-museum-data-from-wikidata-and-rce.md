# ADR-0005: Museum data from Wikidata and RCE; curated Museumkaart flag

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** when the Museumvereniging answers owner action A5 (a feed or a permission).
- **Amended by:** [ADR-0018](0018-wikimedia-commons-images-self-hosted-with-attribution.md) (Commons images, 2026-11-02).

## Context

- The catalogue needs every Dutch museum with name, address, coordinates, website and category. The passport needs to know which museums accept the Museumkaart: about 500, while public counts range from 426 to 539.
- Sources, checked 2026-11-01 (A§7.1, `docs/plan/research/museum-data.md`):
  - **museum.nl:** © Museumvereniging; use is "personal, non-commercial" only; reproduction needs prior written permission; linking is allowed. No API, feed or export found [U]. Even the bare list may fall under the Databankenwet [U].
  - **Wikidata** (CC0): 1,361 NL museums not marked dissolved [U exact query, P1a pins it]. Coordinates 1,071, website 907, street address 752, postcode 537, "Geregistreerd museum" 502, a museum.nl link (P973, stale) 441.
  - **RCE "Musea in Nederland"**, WFS layer `overzichtmusea` (Public Domain Mark): 629 rows with name and address, metadata dated 2026-08-19.
  - **OpenStreetMap:** 1,416 `tourism=museum` objects under the ODbL (share-alike).
  - **Google Places:** the terms allow storing only `place_id` (and lat/lng for 30 days).

## Decision

- **Seed and weekly sync** (D6) from Wikidata SPARQL (key = QID) and the RCE WFS (cross-check and addresses): ~1,360 museums (A§7.2). One query per run, a User-Agent with a contact address, `Retry-After` honoured.
- **One pure matcher** (A§7.3): QID → postcode + normalised name (`pg_trgm`) → under 150 m + name similarity → the admin review queue. Nothing merges automatically below rule 3.
- **Sync and diff** (A§7.4): rows land in `museum_source_row` and the diff writes `museum_change`. Only safe fields auto-apply; unsafe changes wait for review; a museum is never hard-deleted; an empty or malformed source applies nothing.
- **Museumkaart flag** (A§7.5): `museumkaart_status` (`participating` · `left` · `unknown`) with `mk_since`, `mk_until` and `mk_last_verified_at`, curated by the owner (admin CLI, then the admin UI; owner action A6) plus moderated "Meld een wijziging" reports. The owner works from each museum's own website and members' reports (or the A5 answer), never by working through museum.nl's list or filter (database right, A§13.3). P973 links are hints only.
- **N** = the museums `participating` when the last `mk_list_version` was published, copied into `mk_list_member` at publication and counted, never typed; always shown with its date ("37 van 512 · lijst nov 2026").
- **Admission price** (adult, cents, `price_verified_at`), curated for € saved (A§10).
- **Never** fetch, scrape or copy museum.nl; a museum page only links to it. The owner emails the Museumvereniging for a feed or permission, with a "not affiliated" courtesy note (A5).
- No OSM data in our database (only inside the basemap tiles, ADR-0014) and no Google data. Museum images: Wikimedia Commons files from P18, self-hosted with attribution ([ADR-0018](0018-wikimedia-commons-images-self-hosted-with-attribution.md), which amends the earlier "no museum images in v1"; P1a stores the file name, P3b builds the pipeline).
- A museum closed on Wikidata (P576) or by the owner gets `closed_on`; its reviews become read-only.

## Consequences

- Everything stored is CC0, public domain or our own, so the museum table carries no share-alike.
- The owner curates ~500 flags and prices by hand before P2c and P4 (A6), from each museum's own website and members' reports, never from museum.nl's list or filter. They go stale, so pages show `mk_last_verified_at` and members report changes.
- Whether this hand curation is fine under the Databankenwet is [U A9]: that question goes to the lawyer (by email if the paid hour is not booked yet), and A6 starts only after the answer; the rest of A9 before P3d's sign-off of the legal texts. A5's answer may replace it with a feed or a permission.
- ~290 museums without coordinates are listed but not on the map until the owner fixes them in the admin.
- CI never calls Wikidata or RCE: tests use recorded fixtures, and `record-fixture` refuses to run under `CI`.

## Alternatives rejected

- **Scraping museum.nl:** its terms forbid reproduction without written permission, and the list may be protected by the database right [U].
- **OSM in the main table:** ODbL share-alike would bind our museum table.
- **Google Places:** its storage terms (only `place_id`, lat/lng for 30 days), and the browser would make third-party requests.
- **Only Museumkaart museums in the catalogue:** there is no open source of that list, so curation would block the whole catalogue; museums outside the card are worth finding and reviewing too.
