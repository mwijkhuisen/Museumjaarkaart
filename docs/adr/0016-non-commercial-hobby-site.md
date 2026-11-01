# ADR-0016: Non-commercial hobby site

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** only together with new legal advice, if a revenue idea ever comes up.

## Context

- The owner runs the site as a hobby. Running costs are small: a domain ~€20 a year, Lettermint €120 a year from launch, R2 ~€0–10 a year [U] (A§19).
- Research, 2026-11-01 (`docs/plan/research/legal.md`):
  - The EU rules on consumer reviews (say whether and how reviews are checked, no fake reviews) bind **traders**. A no-revenue hobby site is probably not one [U]; ads, affiliate links or sponsorship would change that. ACM fines run up to €900k.
  - **KvK** registration is needed only for independent, paid and regular work.
  - Ad and tracking cookies need consent, and so a banner; one strictly necessary cookie needs neither.
  - The EAA covers services "with a view to concluding a consumer contract", so it does not apply here.

## Decision

- **Never any revenue** (D14): no ads, affiliate links, sponsorship, donations or paid features, and no sale or licensing of data or content.
- Not a trader [U A9]; no KvK registration.
- The consumer-review rules are followed anyway, as good practice (A§13.4): "Hoe wij reviews controleren" beside every score, the staff and reward ban, no suppression of negative reviews (ADR-0017).
- No ad or tracking cookies: one strictly necessary cookie, so no banner (A§13.2).
- Links to museums and museum.nl are plain links, without affiliate parameters.
- The owner pays the costs.

## Consequences

- No pull toward engagement metrics or analytics; the privacy principle (A§2) holds.
- WCAG 2.2 AA is a goal, not a legal duty (A§15.5).
- Any later revenue idea needs a new ADR and legal advice first: trader status, KvK, binding review rules and cookie consent would all change.
- The "not affiliated" footer (ADR-0006) stays true.

## Alternatives rejected

- **Donations:** may already count as remuneration [U], and they bring a payment provider.
- **Ads:** trader status, ad cookies with a consent banner, and third-party scripts that the CSP forbids.
- **Affiliate links (tickets, the card):** trader status, so the review-verification statements become mandatory, and a reason to doubt the rankings.
