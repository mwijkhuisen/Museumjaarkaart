# Research: naming

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report plus the session's own follow-up checks for the owner's shortlist. Domains were checked by RDAP (SIDN for .nl, Verisign for .com) on 2026-11-01 and show availability on that day only. **No name has been cleared as a trademark:** the BOIP, EUIPO/TMview and WIPO registers could not be reached (captchas, "Request Rejected", 503). Conflict ratings come from web, app-store and domain searches only. Outcome: D5, D23, A§1, ADR-0006, owner action A1.

Hard constraints for every candidate: no "kaart", no diacritics, a stem of 16 letters or fewer, sayable in Dutch and English. The closest competitor, MuseoTrack for Museumkaart, resembles none of the names.

## 1. Ranked shortlist (sub-agent)

| # | Name | Meaning (NL / EN) | .nl | .com | Conflict risk | Verdict |
|---|---|---|---|---|---|---|
| 1 | Muzelog | muze (muse) + log / "muse-log" | free | free | Low | Best all-round: short, distinctive, fits the visit log and reviews |
| 2 | Wasdaar | "was daar" / "was there" | free | free | Low | Bilingual check-in pun; the tagline has to say "museum" |
| 3 | Museumvink | vinkje (tick) + vink (finch) / "museum finch" | free | free | Low | Friendly, family-proof, a ready-made mascot; a little generic |
| 4 | Stempelboek | stamp book / museum passport | free | free | Low | Clear in Dutch, but an everyday noun: hard to protect or rank |
| 5 | Muzenpad | path of the muses | free | free | Low | Elegant; check MUZEN (an audio brand) trademarks |
| 6 | Zalenhopper | halls + hopper / "gallery-hopper" | free | free | Low | Playful, but "zalen" suggests party venues |
| 7 | Allemusea | alle musea / "all museums" | free | free | Low | Very clear, but descriptive and close to museum.nl's promise |
| 8 | Slenterzaal | strolling hall | free | free | Low | Warm, says little about reviews or the passport |
| 9 | Museumkwartet | card game of collecting sets | free | free | Medium | Search engines correct it to Museumkwartier |
| 10 | Museumpelgrim | museum pilgrim | free | free | Medium | Long; collides with Museum De Pelgrim (Oldenzaal, a card museum) |
| 11 | Stempo | stempel + tempo | free | taken (parked, for sale) | Medium | An investor holds the .com; stempo.app is a pre-launch running app |
| 12 | Artlas | art + atlas | free | taken (parked) | **High** | **Do not use**: Artlas Inc. runs an AI museum-guide app that covers European museums and filed a US trademark on 2026-05-19 (classes 9, 41, 42); Paris Convention priority for an EU or Benelux filing until ~2026-11-19 |

Notes from the report:
- **Muzelog:** no company, app or account of that name (web, Google Play, App Store NL: 0 results). Muzea.io, an iOS museum-guide app with a "Cultural Passport", shares the "muze-" prefix in the same field; the "-log" ending keeps them apart, but don't copy its passport wording. Two Dutch museums share the prefix visually (Muzee Scheveningen, muZEEum Vlissingen).
- **Wasdaar:** a 2010 app "Ik was hier" (Nationaal Historisch Museum) had the same idea and is defunct. Some readers first read "was" as laundry. ikwasdaar.nl is free as a redirect.
- **Museumvink:** nothing called Museumvink or "Museum Vink" in web, App Store NL, Google Play NL, OSM or KvK searches; museum-vink.nl and .com free too. "Vink" is a common surname (e.g. Galerie De Vink, Utrecht), no culture or app brand.
- **Stempelboek:** would probably be refused as a trademark for being descriptive (the report's inference, not checked); search results are full of hiking stamp booklets.
- Other names with .nl and .com free: Zalenzwerver, Kijkgenot, Rariteitenkast, Bezienswaard, Vitrinevrienden, Museummuis, Suppoost. Dropped because both domains were taken: Kijkdoos, Tentoon, Pronkkamer, Mooigezien, Rondgang, Glimp, Musaic, Curiosa, Videmus, Mirari, Muzerie, Vitrino, Ziezo, Visito, Specto, Atrio, Sokkel.

## 2. The owner's shortlist (D5, owner, 2026-11-01)

The owner asked for Muselog, Museumvink and, if free, Museumlog.

| Name | .nl | .com | .app | Findings | Risk |
|---|---|---|---|---|---|
| **Muselog** | free | taken since 2017, parked for sale (HugeDomains) | taken | "muselog", an open-source Python logging library (The Daily Muse, https://www.github.com/dailymuse/muselog); a Devpost hackathon project "MuseLog". Different fields | Not rated by the report; the .com only by purchase |
| **Muzelog** (z-variant) | free | free | free | See §1 | Low |
| **Museumvink** | free | free | free | See §1 | Low |
| **Museumlog** | free | registered 2025-02-10 (Namecheap DNS, parked, no business seen) | taken: "Museum Log" | See below | **High** |

**Museumlog, flagged.** museumlog.app is "Museum Log — A logbook for your museum visits", tagline "Letterboxd, but for museums":
- an English-language iPhone app (local-first storage, iCloud) by a founder in London, pre-launch ("Notify me on launch"); domain registered 2026-05-04;
- **general and international, not Dutch-specific:** stamps for 130+ galleries worldwide (Tate, MoMA, Pompidou, Louisiana and others), a world map, visits grouped by continent;
- the same product idea (a visit logbook with ratings and photos) under nearly the same name, so it conflicts with the EN side of the site, with app-store listings and with search, even though it does not target the Dutch market. museumlog.com is held by an unknown party.

## 3. Before the owner decides (A1)

1. **Check trademarks by hand.** BOIP and EUIPO (via TMview) for the finalists, exact spellings and look-alikes (muselog/muzelog, museumvink/vink, museumlog). Classes **35** (reviews, ratings, consumer information), **41** (cultural and museum information) and **42** (the software platform); add **9** for a downloadable app. Also the KvK Handelsregister for trade names. If anything is unclear, one clearance search by a Benelux trademark attorney is cheap insurance.
2. **Register the domains the same day** you decide: the .nl and the .com together (and .app if useful), with WHOIS privacy to match the privacy-first approach.
3. **Claim social handles** (not checked): Instagram, TikTok, Bluesky, Mastodon, YouTube (for video later), Facebook, GitHub, even if they stay quiet until launch.
4. **Test it out loud:** ~5 Dutch and ~5 English speakers say the name and spell it after hearing it once; drop any name that fails.

The code never depends on the choice: the brand lives in config (`MJK_BRAND_NAME`, `MJK_DOMAIN`) and the i18n messages; the code name is `mjk` (D23). A1 is due before P1c (brand strings) and P1e (domain).
