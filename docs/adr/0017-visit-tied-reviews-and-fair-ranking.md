# ADR-0017: Reviews tied to a logged visit; Bayesian ranking

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** C and m after the beta (P4); trust weighting after the beta.

## Context

- Prior art (ADR-0001): Google and Tripadvisor own the review volume. What they lack is reviews by card holders tied to their visits, answering "is this worth a trip on the card?".
- Visits cannot be checked: we have no access to card scans, and Mijn Museumkaart hides its visit history for now.
- Counts per museum will be small. With a plain mean, one 5-star review outranks 200 reviews averaging 4.6.
- Prior art points at a Bayesian ranking (a hobby ranking page), trust weighting (FijnUit) and a "hide ratings before my visit" option that a MuseoTrack user asked for [U].
- The review-verification rules bind traders only; we follow them as good practice (ADR-0016).

## Decision

- **One review per member per museum** (D13), editable at any time. Earlier versions go to `review_revision` (for moderation, never public), and the review shows "bewerkt op <date>".
- **Tied to a visit** (D17): a review cites one of the member's visits to that museum, shown as "Bezocht op <date>" ("Bezocht" if undated). Visits are self-declared. Deleting the cited visit asks the member to pick another one or delete the review.
- **Scores** (A§11): overall 1–5 stars, required, which drives every average. Optional aspects 1–5: collection, presentation, kid-friendly, accessibility, facilities, value for money (D13) [U final list in P3a]. An aspect mean shows from 3 ratings [U].
- **Text:** optional, plain (line breaks only), any language, ≤ 5,000 characters. Up to 10 photos (ADR-0008).
- **Ranking:** the museum page shows the plain mean and the count. Lists order by the Bayesian average `(C·m + Σ ratings) / (C + n)`, with C = 5 and m = the global mean of visible ratings [U tune after the beta]. The worker recomputes `museum_stats` in a debounced job.
- **"Hide ratings until I've visited"** (D20): a member setting that folds scores and texts on museums the member has not visited (A§11).
- **"Hoe wij reviews controleren"** beside every score: visits are self-declared; one review per member per museum; how the mean and the ranking are computed; negative reviews are never suppressed or demoted; staff and rewarded reviews are forbidden; how to report a review.
- A closed museum's reviews are read-only (ADR-0005).

## Consequences

- Every review comes from a member with a logged visit, and reviewing grows the member's passport.
- A member can lie about a visit; the site says openly that visits are not checked.
- Rankings resist a single extreme rating, and a new museum starts near the global mean.
- A repeat visit updates the one review; the passport keeps every visit.
- fast-check property tests cover the ranking (A§18).

## Alternatives rejected

- **Reviews without a visit:** loses the one thing Google and Tripadvisor lack (prior art).
- **A plain average for ranking:** one 5-star review tops the list.
- **One review per visit:** chosen against (D13). Repeat visitors would weigh more, and a museum page would fill with one member's entries.
- **Proof of a visit (ticket photos, card scans):** no access to scan data, and a ticket photo is forgeable personal data.
- **Trust weighting (FijnUit-style):** hard to explain on "Hoe wij reviews controleren"; revisited after the beta.
