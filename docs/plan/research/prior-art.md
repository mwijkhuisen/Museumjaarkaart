# Research: prior art and competitors

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report, verified: searchers listed about 70 products; the closest were then checked one by one (store pages, developer sites, AppGoblin, live dashboards). Outcome: ADR-0001, A§1, D17, D18, D20, A11.

**Legend:** † = product or figure not independently checked (from the searchers only) · p = private or single-user · i = imported from Google or Tripadvisor · ~ = partial.

## 1. Verdict

**No product does all of this yet, but each half exists.**

- **Personal passport half:** private apps.
  - **Cultra** (https://www.titdev.nl/cultra, TIT B.V., The Hague): flags all 533 Museumkaart museums, progress ring per province, visit log, wishlist, map, NL and EN. iOS 1.0 on 2026-07-20, 1.6.3 on 2026-10-27 (18 releases in ~3.5 months); ~50 installs and ~5 monthly users (AppGoblin: https://appgoblin.info/apps/6761013439); Google Play "0+ downloads".
  - **MuseoTrack†** (https://museotrack.nl): much the same on iOS since 2024-12-16; v1.9.0 on 2026-10-26; ~85 monthly users (AppGoblin), ~2.1K installs†.
  - Both keep data on the device, have no public reviews and almost no users.
- **Public reviews half:** Google Maps and Tripadvisor. Their volume is out of reach (Tripadvisor ~64.8K reviews for the Anne Frank House). Neither knows the Museumkaart or tracks progress.
- **WhichMuseum†** (https://whichmuseum.nl): the only public review community with a Museumkaart list; no passport, no social layer, few reviews.
- Nothing combines a Museumkaart catalogue, a public passport, reviews by card holders and a social layer on an NL/EN website. The closest to the full idea is one hobbyist's hand-built dashboard (#Museumkaarttour, 471 of 533 visited). Demand is real but niche.

## 2. Feature matrix

| Product | Catalogue | MK flag | Visit log | Progress | Wishlist | Ratings | Reviews | Photos | Videos | Map | Social | NL UI | Active? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Google Maps | ✓ | ✗ | ~ (auto, opt-in) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ |
| Tripadvisor | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ |
| Cultra | ✓ | ✓ | ✓p | ✓ (per province) | ✓ | ✓p | ✗ | ✓p | ✗ | ✓ | ✗ | ✓ | ✓ (new) |
| #Museumkaarttour | ✓ | ✓ | ✓p | ✓ (per province) | ~ | ✓p | ✓p | ✓p | ✗ | ✓ | ~ | ✓ | ✓ (ends ~2027) |
| MuseoTrack† | ✓ | ✓ | ✓ | ✓ | ✓ | i | i | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ (iOS only) |
| WhichMuseum† | ✓ | ✓ | ~ | ✗ | ✓ | ✓ | ✓ | ? | ✗ | ✓ | ✗ | ✓ | ✓ |
| MuseumsAtlas† | ✓ | ~ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ (Oct 2026) |
| Museumkaart app + museum.nl† | ✓ | ✓ | ✗ | ✗ | ✓ (site) | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |

- **Google's social layer** is now helpful votes and shared lists only: following ended in September 2025 and users can't comment on reviews (https://www.androidauthority.com/google-maps-follow-feature-ending-3580826). Its visit log is the opt-in, on-device Timeline; a museum can't be ticked off by hand. No "N of M museums" progress.
- **MuseumsAtlas** mentions the Museumkaart only in admission text.

**Threat levels (verified):**

| Product | Threat | Why |
|---|---|---|
| Google Maps | medium | Where most people already rate, review and photograph museums; nothing Museumkaart-specific, no passport |
| Tripadvisor | medium (high on reviews, low on the rest) | Large Dutch review and photo bases for nearly every card museum; no card awareness, no passport |
| Cultra | medium | Covers the passport half almost fully, free, actively developed; private, app-only, no public reviews |
| #Museumkaarttour | low as a product | One person's read-only dashboard; the strongest proof the idea is wanted; projected to end ~2027-02-01 |
| Yelp | low | Generic mechanics; Dutch activity concentrated in Amsterdam; regional museums 0–8 reviews |
| Palette (London galleries) | low | Proves "Letterboxd for exhibitions" works; no overlap with the Dutch market |

## 3. What the official side already gives (don't rebuild)

- **App** (https://play.google.com/store/apps/details?id=nl.museum.app): digital card with an offline barcode, partner and child cards, buy, gift and renew, nearby museums, exhibitions.
- **museum.nl:** a finder with category, facility, province and near-me filters, a "Museumkaart geldig" filter, a map, an agenda of 600+ exhibitions, shareable favourites.
- **Mijn Museumkaart:** every scan is recorded; the FAQ says visits are "tijdelijk niet meer zichtbaar… In de toekomst zijn je bezoeken weer zichtbaar."
- **It lacks:** visible visit history, progress, ratings, reviews, user photos, anything social; good search (several provinces at once, radius, remembered filters); satisfaction (the app is rated 2.2 on Google Play).
- The children's review scheme (Museumkids, Kid-approved label) was wound down after 2023†.
- **So:** link out to the card, the agenda and the basic finder.

## 4. Gaps this site could own (ranked)

1. **A public passport and profile on any device through the web, Android included.** Every tracker is private, iOS-first or tied to one browser. MuseoTrack users reported losing their data ("ALLES WEG", January 2026†).
2. **Reviews by card holders, tied to a logged visit:** "is this worth a trip on the card?", not a tourist's verdict; also ranks the lesser-known museums.
3. **A social layer for museum-goers** (follows, feed, comments): Google dropped it; no Dutch product has it.
4. **Better discovery than the official app:** several provinces, radius, Museumkaart-only and "not yet visited" filters.
5. **A savings stat** (€ saved against the card price): Museumteller†, Anya Prosvetova's dashboard and e-cal's explorer† all show it.

## 5. Risks from prior art

- **The official side catches up:** visit history is promised back; Q42 lists suggestions based on visit behaviour as a future plan† (https://www.q42.nl/en/work/museumvereniging-museumkaart-app); Finland's Museokortti app† already combines check-in, history and reviews. With 500K+ installs, the official app could make the passport half worthless overnight.
- **Review gravity:** Google (~104K reviews for the Rijksmuseum†) and Tripadvisor dominate; Dutch review sites stay thin (FijnUit† 1 review for Teylers; Yelp NL 0–8 for regional museums). The cold start is the most likely way this fails.
- **Small apps move fast:** Cultra shipped 18 releases in 3.5 months; MuseumsAtlas† already has a web version and its own "Museumpaspoort".
- **Name and trademark:** "Museumkaart" and the old name "Museumjaarkaart" belong to the Museumvereniging or Stichting Museumkaart (registration not checked). Avoid implying affiliation; Cultra states it has none. MuseumsAtlas already uses "Museumpaspoort".
- **Data access:** no public API; hobbyists scrape museum.nl, MuseoTrack and WhichMuseum†, which may run into terms or database rights. Sources disagree on the number of card museums: 426, 502, 510, 533, 539, so N needs one stated source with a version date. Google review content can't be reused.

## 6. Plan implications (as proposed by the report)

- **Positioning:** a public passport plus card-holder reviews, web-first as a PWA, Dutch by default; not "another tracker" or "another review site".
- **Beta:** catalogue on the "Museumkaart geldig" list; manual visit tick-off with a date, progress per province, wishlist, € saved; a rating and short review tied to a logged visit with a "visited" badge, plus photos; a map with Museumkaart, province, not-yet-visited and near-me filters; a public profile.
- **After the beta:** helpful votes and comments, then follows, the feed last.
- **Defer or drop:** video (Google has it; storage and moderation cost); the exhibitions agenda (museum.nl and Museumtijdschrift cover it).
- **Imports:** MuseoTrack's CSV and Cultra's export; generic CSV; Google Timeline†; Mijn Museumkaart history if it returns (uploaded by the user, never scraped).
- **Seed content:** approach Jelte Liemburg (with permission) for their 471 reviews; invite Anya Prosvetova and e-cal; recruit on r/thenetherlands.
- **Review quality:** only visit-tied reviews; FijnUit-style trust weighting; a Bayesian ranking like felicitynayong's; "hide ratings before my visit" (asked for by a MuseoTrack user†).
- **Sizing:** plan for a niche: MuseoTrack has ~85 monthly users after two years.

The plan departs from this: the catalogue is all ~1,360 NL museums from Wikidata + RCE, with the card flag curated, and no OSM data (A§7).

## 7. Demand signals

- **#Museumkaarttour:** Jelte Liemburg's dashboard (https://datastudio.google.com/reporting/f7b832ea-9182-4663-a45b-64e6413be493/page/55e0C), live on 2026-11-01: 471 of 533 visited (88.4%), last visit 2026-07-26, projected end 2027-02-01. Bluesky account with 874 followers (https://bsky.app/profile/jelteliemburg.bsky.social); kickoff tweet 583 likes (https://x.com/jelteliemburg/status/1558082202113638402).
- **Anya Prosvetova built their own tracker twice†:** https://museumkaart-explore.netlify.app/ (last built 2026-10-11).
- **Other hobby tools:** e-cal's explorer† (https://e-cal.github.io/museumkaart-explorer/, data checked July 2026), felicitynayong's ranking page† (https://felicitynayong.github.io/, 2026-06-24).
- **Reddit:** an r/thenetherlands thread asking for the best Museumkaart recommendations, 113 points and 94 comments†; the only tool mentioned was Jelte's dashboard (https://reddit.sentinel-team.org/posts/1td3gki/snapshots/2026-05-14T19%3A19%3A02.453886Z).
- **Many builders, few users:** four indie trackers launched in 2026, all with tiny traction: Cultra, Museumteller†, Museumate†, MuseumsAtlas† (https://museumsatlas.com/nl/).
- **Market size:** 1.54M card holders (https://www.dutchnews.nl/2026/01/more-people-have-a-museumkaart-and-digital-cards-are-popular/), 9.7M visits in 2025 (https://nos.nl/l/2600159).
- **Counter-signal:** Cultra ~50 installs (https://appgoblin.info/apps/6761013439); MuseoTrack ~2.1K installs† (https://museotrack.nl).
