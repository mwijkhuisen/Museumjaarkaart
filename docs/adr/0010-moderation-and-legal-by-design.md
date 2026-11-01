# ADR-0010: Moderation and legal compliance by design (DSA, GDPR, copyright)

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** after the paid hour of Dutch legal advice (owner action A9), before P4.

## Context

- The site hosts members' reviews, photos and profiles (later comments and video), run from the Netherlands by a private person without revenue (ADR-0016).
- Research, 2026-11-01 (`docs/plan/research/legal.md`):
  - **GDPR** applies: publishing to everyone is not household use (Lindqvist, C-101/01).
  - **DSA:** it covers services "normally provided for remuneration", and ACM's guidelines say free services can qualify; whether this site is in scope is [U]. The hosting duties (Art. 11, 12, 14, 16, 17, 18) are cheap. Art. 15, 20 and 21 do not apply to micro services (Art. 19) [U].
  - **Copyright and portraits:** no panorama freedom inside a museum (Aw art. 18 covers works placed permanently in public places) [U]; 70 years after the author's death; portraits under Aw art. 21. Photos carry the copyright, portrait and CSAM risk. For text, the reviewer is primarily liable for defamation.
- The owner moderates alone at first (D9).

## Decision

- **Moderation flow** (D9, A§13.1): text reviews (and P6 comments) go live at once. Photos (later video) from untrusted accounts wait in a queue on the VM, never on R2, visible only to their author (and moderators) through the `api`; trusted = ≥ 3 approved photos and an account ≥ 14 days old, or set by a moderator [U]. A `moderator` role exists.
- **The DSA as if it applies** (A§13.1): `/contact` as the single point of contact (Art. 11/12); versioned terms with the upload licence (Art. 14); "Meld inhoud" on every review, photo, profile and comment, with a receipt and a decision mail (Art. 16); a statement of reasons for every removal, restriction, rejection and ban (Art. 17); an Art. 18 runbook; a simple "bezwaar maken" link anyway.
- **Records:** `notice`, `moderation_action` and an INSERT-only `audit_log` (A§8); a SHA-256 blocklist of removed media; Cloudflare's CSAM Scanning Tool on the zone (owner action A2).
- **GDPR** (A§13.2): a layered privacy page (the AP's checklist, Cloudflare named first); export; deletion with a choice (D10: delete everything, or keep reviews without photos as "voormalig lid", A§13.5); the retention table; an Art. 30 register and `processors.md` (per processor: service, data, location, transfer basis, DPA version and date) in `docs/legal/`, and the breach runbook `docs/runbooks/breach.md`; 16+ at sign-up; EXIF/GPS stripped; no analytics; one strictly necessary cookie, so no banner. IP addresses: only prefixes in the limiter, and the full IP of content-creating requests for 30 days [U P3d]. Account deletion does not erase `content_ip_log` rows before their 30 days end (`user_id` set to null) or notices the member filed (kept 3 years [U]), A§13.5.
- **Copyright** (A§13.3): the member keeps the copyright and grants a non-exclusive, royalty-free licence to store, transcode and display, which ends on deletion; three checkboxes at upload; the museum's `photo_policy`; the notice form offers the `notice.category` list (A§8): copyright, portrait right, privacy, defamation, CSAM, threat, other illegal content, terms breach, plus appeals. Name and email are required except for CSAM (DSA Art. 16(2)(c)); a CSAM notice without them gets no receipt mail. A threat marks the item urgent and links the Art. 18 runbook.
- **Built in M3** (P3c, P3d), before the beta, with tests (A§18). One paid hour of Dutch legal advice checks the [U] points (A9); its database-right question is asked before A6 (ADR-0005).

## Consequences

- Legal duties are features with tests, reviewed under `review:security`.
- The owner's daily load is the photo queue plus notices; text is handled after a notice.
- If A9 finds that the DSA does not apply, nothing is removed: the flows stay as good practice.
- A kept "voormalig lid" review can still identify its author [U]; the deletion page warns.
- Notices, moderation actions and the text of removed reviews and comments are kept as evidence for 3 years [U]. Removed photos are not kept: only their sha256 stays in `blocked_hash`; CSAM is reported, then deleted, never kept [U A9].

## Alternatives rejected

- **Pre-moderate everything:** the owner alone cannot keep up, and reviews are the content that has to go live; there is no general monitoring duty (DSA Art. 8).
- **Post-moderate everything:** a photo carries the copyright, portrait and CSAM risk and sits in the edge cache once it is public.
- **Only delete, or only anonymise, at account deletion:** D10 gives the member the choice.
- **Wait until the DSA is proven to apply:** fitting notices and statements of reasons around live content later is harder than building them first.
