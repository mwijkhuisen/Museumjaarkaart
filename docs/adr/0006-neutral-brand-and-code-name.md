# ADR-0006: Neutral public brand; internal code name `mjk`

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** when the owner picks the brand (owner action A1).

## Context

- The repository is called Museumjaarkaart. museum.nl states that the Museumkaart name and logo are protected as trademarks; "Museumjaarkaart" was the card's name until about 2003 [U]. The BOIP and EUIPO registers could not be reached during research, so no entry, class or name has been checked [U].
- A site or domain called "Museumjaarkaart" suggests a link to the card and invites a cease-and-desist or a domain dispute. Describing a museum as "Museumkaart geldig" is lower risk [U].
- The owner's shortlist (D5; `docs/plan/research/naming.md`), with domains checked by RDAP on 2026-11-01:
  - **Muselog** (.nl free, .com taken; a Python library and a hackathon project share the name) / **Muzelog** (.nl, .com and .app free).
  - **Museumvink** (.nl, .com and .app free).
  - **Museumlog** (.nl free, .com taken): a high conflict. museumlog.app is "Museum Log", an international, English-language, pre-launch visit-logbook app (registered 2026-05-04).
- No name on the list has been cleared as a trademark.

## Decision

- The public brand and domain never contain "Museum(jaar)kaart" (D5, A§1). "Museumkaart geldig" appears only as a description, and the footer says the site is not affiliated with the Museumvereniging or the Museumkaart (A§13.3).
- The owner picks from the shortlist after a BOIP and EUIPO/TMview check (classes 35, 41 and 42; +9 if an app ships) and registers `<domain>` .nl (+ .com) with WHOIS privacy: owner action A1, before P1c (brand strings) and P1e (domain).
- **Code name `mjk`** (D23; A§6, A§17.3) for everything internal:
  - packages `@mjk/server`, `@mjk/web`, `@mjk/contracts`, and the export condition `mjk-dist`
  - the compose project `mjk`, paths `/etc/mjk` and `/srv/mjk`, units `mjk-*`, config prefix `MJK_`
  - images `ghcr.io/mwijkhuisen/mjk-server`, `mjk-web` (later `mjk-media`)
  - it is never shown to visitors.
- The brand lives only in config (`MJK_BRAND_NAME`, `MJK_DOMAIN`) and the i18n messages (ADR-0013). The plan writes `<brand>` and `<domain>`. The repository keeps its name.

## Consequences

- P0 to P1b do not wait for the brand; P1c needs the strings and P1e the domain.
- A later brand change is config, messages and DNS, not code. A **domain** change is heavier: the Access application, the R2 custom domain, the mail DNS records and the passkeys' RP ID are bound to `<domain>`, so passkeys made after P2b stop working (the email code still signs members in, ADR-0007).
- The Museumlog conflict and every [U] trademark point are the owner's to settle in A1.

## Alternatives rejected

- **Keep "Museumjaarkaart":** trademark risk, and it suggests affiliation with the card.
- **Wait for the brand before writing code:** a rename later touches every path, package, image, unit and test.
- **Use the brand as the code name:** the same rename problem every time the brand changes.
