# ADR-0001: Product: public museum catalogue, passport-first, invite-only beta

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** at the end of the beta (P4), or when the official Museumkaart app shows visit history again.

## Context

- The owner wants a site where Museumkaart holders rate and review museums with photos (and video), plus a museum passport, a wishlist, a map and a social layer (D3; `docs/plan/planning-prompt.md`).
- Prior art, checked 2026-11-01 (`docs/plan/research/prior-art.md`):
  - **Passport half:** private apps only. Cultra (iOS, NL/EN) flags all 533 Museumkaart museums, with progress per province, a visit log, a wishlist and a map; data stays on the device; ~50 installs [U]. MuseoTrack (iOS, since Dec 2024) is similar, with ~85 monthly users [U]. MuseumsAtlas (web, Oct 2026) has its own "Museumpaspoort" [U].
  - **Review half:** Google Maps and Tripadvisor, with volume out of reach (~64.8K Tripadvisor reviews for the Anne Frank House) and no notion of the card. WhichMuseum is the only public review community with a Museumkaart list, and it is thin [U].
  - **The official side:** the app and museum.nl give the card, a finder and an agenda. Visit history is "temporarily" hidden, there are no reviews, and the app scores 2.2 on Google Play.
  - Demand is real but niche: a hobbyist's hand-built #Museumkaarttour dashboard (471 of 533 visited), several hobby trackers, an r/thenetherlands thread [U].
- The owner moderates alone at first (D9).

## Decision

- **Product** (A§1): a public NL/EN website with a catalogue of all ~1,360 Dutch museums, search, filters and a map (A§7, A§15.3); a museum passport (A§10); ratings and reviews tied to a logged visit (A§11, ADR-0017); photos (A§12); public profiles. Web-first, with a PWA instead of a native app (P5a).
- **Audience** (D1): anyone browses; sign-up is invite-only during the beta (invite codes, A§9) and opens in P5a.
- **Passport-first beta** (D18): catalogue, map, search and filters; passport (progress against N per province and in total, all time, per year); wishlist; € saved; bulk "already visited" onboarding; import and export (D20); ratings and reviews, with a review prompt right after a visit is logged (a rating alone is enough, P3a); photos; profiles.
- **After the beta** (D18): helpful votes and comments (P6a) → follows and shared passports (P6b) → the feed last (P6c). Video only if beta users ask for it (P7, D19).
- **Privacy defaults** (D12): profiles, reviews and photos are public; the visit log and wishlist are private unless the member makes them public (followers-only from P6b).
- **Non-goals** (A§1): selling or showing the card, tickets, opening hours and the agenda (we link out), a native app, any revenue (ADR-0016), museum accounts or a right of reply in v1.

## Consequences

- Positioning: a public passport plus card-holder reviews, not another private tracker and not another review site.
- Abuse and moderation stay small while the DSA flows (ADR-0010) prove themselves in the beta.
- Every public page works without an account; logged-in screens add the personal layer (ADR-0009).
- Plan for a niche (A§17.1, A§19). The beta is seeded by hand (owner action A11, which also asks the #Museumkaarttour author whether to bring their own reviews); imports from MuseoTrack, Cultra and CSV (A10, P2c) lower the cost of switching. From P3a the generic CSV also takes optional `rating` and `review` columns, the member's own words only, each creating a review on the imported visit (A§10).
- Risks (A§20): the official app restores visit history and makes the passport half less special; the review cold start is the most likely failure; small apps move fast and may add a public side.

## Alternatives rejected

- **Reviews only, no passport:** competes head-on with Google's and Tripadvisor's volume, with nothing they lack.
- **A private passport app like Cultra or MuseoTrack:** it already exists, mostly on iOS, and MuseoTrack users reported losing their data [U].
- **The social layer in the beta:** follows and a feed need content first (D18).
- **Open sign-up from day one:** abuse and moderation load before the notice-and-action flows have run for real (D1).
- **A native app:** two app stores and their reviews, plus a class 9 trademark check; a PWA reaches Android, iOS and desktop from one code base.
