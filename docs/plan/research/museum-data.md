# Research: museum data

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report. The Wikidata, OSM taginfo, RCE WFS and museum.nl sitemap checks were run on 2026-11-01. The BOIP and EUIPO registers could not be reached, so trademark points are **[U]**. Outcome: D6, A§7, ADR-0005.

## 1. Museumkaart participants (museum.nl)

- **Count:** about 500 museums. 1.54M card holders and 9.7M visits in 2025 (DutchNews, Jan 2026: https://www.dutchnews.nl/2026/01/more-people-have-a-museumkaart-and-digital-cards-are-popular/). The 2024 handbook for museums says "> 500 museum locations" (https://museumvereniging.nl/wp-content/uploads/2024/11/Museumkaart-Handleiding-voor-musea-2024-1.pdf).
- **Price:** €75 adult, €39 under 19 (https://www.museum.nl/nl/museumkaart/faq).
- **No official API, feed, open-data export or partner programme found [U].**
  - The list at https://www.museum.nl/nl/zien-en-doen/musea renders in the browser, with filters for "Museumkaart geldig" and category (Kunst, Geschiedenis, Natuurhistorie, Bedrijf/wetenschap/techniek, Volkenkunde).
  - robots.txt allows everything; the sitemap (https://www.museum.nl/sitemap.xml, lastmod 2026-10-28) has about 470 museum slugs with exhibition or object subpages (rough count).
  - Museum pages show opening hours and a "Favoriet" button, no reviews.
  - An old community gem read an XML feed from museumjaarkaart.nl (https://github.com/henkm/museumkaart); probably defunct [U].
- **Terms:** the disclaimer (https://www.museum.nl/nl/disclaimer) says all texts, images and navigation material are copyright of the Museumvereniging; use is "personal, non-commercial" only; reproducing or publishing needs prior written permission; framing is forbidden, linking allowed. The card-holder terms (https://www.museum.nl/nl/gebruiksvoorwaarden, amended 2026-10-28) say nothing about scraping or reuse.
- **Database right:** even the bare list may fall under the Databankenwet, which forbids extracting a substantial part of a database (https://wetten.overheid.nl/BWBR0010591) [U whether it applies].

## 2. Alternatives

All have reuse-friendly licences except Google.

- **Wikidata** (CC0, https://www.wikidata.org/wiki/Wikidata:Licensing): a SPARQL count found **1,361** museums in NL not marked dissolved.

  | Field | Property | Items |
  |---|---|---|
  | Coordinates | P625 | 1,071 |
  | Website | P856 | 907 |
  | Image | P18 | 841 |
  | Street address | P6375 | 752 |
  | Postcode | P281 | 537 |
  | "Geregistreerd museum" (Museumregister) | P166 = Q110989587 | 502 |
  | museumkaart.nl / museum.nl link ("described at URL") | P973 | 441 |

  - P973 links are a stale but useful hint of card participation. There is no Museumkaart or Museumregister ID property.
  - Commons images carry per-file licences (often CC BY-SA), each needing attribution.
  - Wikidata answered 429 once during the checks: send a proper User-Agent and respect the rate limits.
- **OSM:** 1,416 objects tagged `tourism=museum` (https://taginfo.geofabrik.de/europe:netherlands/api/4/tag/stats?key=tourism&value=museum, data to 2026-10-31).
  - ODbL is share-alike: OSM data merged into our museum table makes that table ODbL.
  - Reviews can stay outside it if OSM and non-OSM data stay independent per data type (https://osmfoundation.org/wiki/Community_Guidelines/Collective_Database_Guideline_Guideline).
- **RCE "Musea in Nederland":** Public Domain Mark. WFS layer `overzichtmusea`, **629** records (https://services.rce.geovoorziening.nl/Veiligheid_van_Erfgoed/wfs): name, street, number, postcode, place, municipality. Registered museums plus some others; metadata dated 2026-08-19.
- **Museumregister Nederland:** 511 entries at the end of 2021 (https://www.museumregisternederland.nl/Portals/0/MuseumregisterNederland-jaarverslag-2021.pdf). List at `/register-bekijken`, no export found [U].
- **Google Places:** unusable as a stored source: only `place_id` may be kept indefinitely and lat/lng for 30 days (https://cloud.google.com/archive/maps-platform/terms/maps-service-terms-20251118). It would also break the no-third-party-requests rule.

## 3. Trademark

- museum.nl: "De naam, het logo van de Museumkaart … zijn merkenrechtelijk beschermd". The register entry, its classes, and whether "Museumjaarkaart" is registered too were not checked [U].
- "Museumjaarkaart" was the card's name until about 2003 [U].
- A site or domain called "Museumjaarkaart" suggests a link to the card and invites a cease-and-desist or a domain dispute. "Accepts the Museumkaart" in body text is lower risk.

## 4. Existing products

See [prior-art.md](prior-art.md) for the verified analysis. This report found: the official app (https://www.q42.nl/en/work/museumvereniging-museumkaart-app: digital card, museum and exhibition info, visit features only planned [U]); MuseoTrack (https://apps.apple.com/us/app/-/id6738280332: free iOS, visits, CSV export, achievements, Tripadvisor reviews, 4 ratings); general review sites (DagjeWeg, Fijnuit, Zoover, Tripadvisor, Google), none built around the card.

## 5. Proposed seeding and sync

- **IDs:** our own UUID; the Wikidata QID as the main external key; museum.nl slug, RCE row key and (optionally) OSM id as reference columns only.
- **Initial import:** (1) Wikidata SPARQL for name, coordinates, website, address, registered status; (2) enrich and cross-check with RCE WFS; (3) set the Museumkaart flag by hand (curated boolean + link out to museum.nl), copying no museum.nl texts or images.
- **Descriptions and images:** our own short text, plus Commons images with attribution, self-hosted so the browser stays first-party.
- **Matching order:** QID → 6-character postcode + normalised name (pg_trgm similarity) → distance < 150 m + name similarity → admin review queue.
- **Refresh:** weekly job into staging tables, diff, auto-apply only safe fields.
- **Joining or leaving the card:** never hard-delete. `museumkaart_status` (participating / left / unknown) with since/until dates and `last_verified_at`. A museum dissolved on Wikidata (P576) is marked closed and its reviews become read-only; reviews always stay attached. Users can report a status change for moderation.

## 6. Recommendation

- Seed from Wikidata + RCE (~1,361 museums, all reusable).
- Curate the Museumkaart flag by hand; in parallel, email the Museumvereniging for a feed or written permission.
- Keep OSM out of the main table, or as a separate collective layer.
- Pick a neutral brand without "Museum(jaar)kaart" and add a "not affiliated" notice.

## 7. Questions it raised (answered in the interview, A§3)

Scope (all ~1,400 or only ~500 card museums) · rename and BOIP search · contacting the Museumvereniging · who maintains the flag · Commons images or user photos only · OSM at all · visit log public or private · NL only or NL + EN.
