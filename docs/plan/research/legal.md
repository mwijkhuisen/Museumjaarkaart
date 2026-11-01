# Research: legal (NL / EU)

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report on the legal duties of a Dutch, no-revenue hobby review site, turned into plan items. Not legal advice: the owner books one paid hour of Dutch legal advice before the beta (A9). Outcome: D9, D10, D14, A§13, ADR-0010, ADR-0016.

**Legend:** **[M]** mandatory · **[M\*]** mandatory if the regime applies (assume it does) · **[G]** good practice · **[U]** not verified. Sources were fetched where noted; the rest come from search snippets.

## 0. Which rules apply

- **GDPR always applies:** publishing to an unlimited audience is not household use (Lindqvist C-101/01, https://fra.europa.eu/sk/caselaw-reference/cjeu-case-c-10101-judgment).
- **The DSA may not apply:** it covers services "normally provided for remuneration"; ACM notes free services can still qualify (Papasavvas, McFadden), ACM DSA guidelines §25 and fn 37 (https://www.acm.nl/system/files/documents/guidelines-dsa-due-diligence-obligations-for-intermediary-services.pdf, fetched). Whether a no-revenue private person is a "provider" at all is [U]. Plan for it anyway: the hosting duties are cheap.
- **Consumer-review law applies only to traders** (§3).

## 1. GDPR / AVG

- **[M] Lawful basis:** account, reviews and media: contract (6(1)(b)) via the terms; abuse and security logs: legitimate interest (6(1)(f)), named; optional emails: consent.
- **[M] Privacy page** with the AP list (https://www.autoriteitpersoonsgegevens.nl/en/themes/basic-gdpr/privacy-rights-under-the-gdpr/right-to-information): identity and contact, purposes and basis, recipients, transfers outside the EEA, retention, rights, the right to complain to the AP. AP advises a layered format.
- **[M] Rights flows:** export (JSON + ZIP of the user's own media); deletion (profile, reviews, ratings, media, then recompute averages; backups purged within a documented N days). "Anonymise instead" is [U], because review text can still identify the author.
- **[G/M\*] Age 16+:** sign-up checkbox and `age_confirmed_at`. UAVG art. 5 requires parental consent under 16 when the basis is consent. From 1 Sep 2026, 12–16-year-olds can withdraw consent and exercise their rights themselves (Stb. 2026, 154: https://www.njb.nl/wetgeving/staatsbladen/verzamelwet-gegevensbescherming/).
- **[M] Privacy by design (Art. 25):** strip EXIF and GPS from every upload; log nothing that isn't needed.
- **[M] Processors:**
  - Cloudflare: the DPA is incorporated by reference (§6.1) in the Self-Serve Agreement (https://www.cloudflare.com/terms/), which also covers Free Services (§2.6); explicit Free-plan coverage [U]. US transfer relies on the DPF, upheld on 3 Sep 2025, under appeal as C-703/25 P (https://www.wilmerhale.com/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20251201-european-court-of-justice-to-review-challenge-to-eu-us-data-privacy-framework).
  - Email provider: needs a DPA; prefer an EU provider.
  - Storage on the owner's own box: no processor.
- **[M] Internal paperwork:** an Art. 30 register and a breach runbook (report to the AP within 72 hours).
- **[M] Cookies:** one strictly necessary session cookie needs no consent and no banner (https://ondernemersplein.overheid.nl/wetten-en-regels/gebruik-van-cookies-op-uw-website/); mention it on the privacy page.

## 2. DSA (ACM supervises since 4 Feb 2025: https://www.acm.nl/en/publications/acm-now-fully-authorized-enforce-digital-services-act)

- **[M\*] Art. 11/12:** a `/contact` page as the single point of contact for authorities and users: electronic, naming its languages (NL, EN), not only automated.
- **[M\*] Art. 14:** terms describing content rules, moderation tools and human review, plus how users are told of changes.
- **[M\*] Art. 16:** a "Meld illegale inhoud" button next to every review, photo and video. The form asks for the reason the content is illegal, the exact item or URL, the notifier's name and email, and a good-faith statement. It sends an automatic receipt, then the decision with redress options (ACM §109–113).
- **[M\*] Art. 17:** a statement of reasons for every removal, demotion or suspension: the restriction, the facts, the legal ground or terms clause, whether automation was used, the redress options (ACM §122–125).
- **[M\*] Art. 18:** a runbook to report threats to life or safety to the police at once.
- **Art. 19 exemption** for micro and small enterprises (https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-19/): no Art. 15 transparency report, no Section 3 (complaint system, out-of-court settlement, trusted flaggers). **[G]** offer a simple "appeal" anyway.
- **Liability:** none without actual knowledge, but act quickly after a valid notice; voluntary moderation keeps the protection (Art. 6–8, https://eur-lex.europa.eu/eli/reg/2022/2065/oj).
- **Data model:** `notice(target, category, explanation, notifier_name/email, good_faith, received_at, ack_at, decision, decided_at)` · `moderation_action(target, type, ground_kind law|tos, ground_ref, facts, automated, sor_sent_at)` · `user.status` · an append-only audit log · an admin moderation queue.

## 3. Reviews and consumer law

- The duty to say whether and how reviews are verified (on the page with the reviews) and the fake-review ban apply to **traders** (EC UCPD Notice 2021: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A52021XC1229%2805%29). Consumers posting reviews are outside it. A no-revenue hobby site is probably not a trader [U]. Ads, affiliate links or sponsorship would change that; ACM fines run up to €900k (https://www.acm.nl/nl/publicaties/acm-aanpak-verkoop-nepreviews-nieuwe-stap-bestrijding-online-misleiding).
- **[G] Do it anyway:** a "Hoe wij reviews controleren" link beside every score (visits are not verified, how the average is computed, negative reviews are not suppressed); a ban on reviews by museum staff or for rewards; a self-declared `visited_on`.
- **Defamation:** the reviewer is primarily liable (free speech vs reputation, https://www.dirkzwager.nl/kennis/artikelen/onrechtmatige-reviews-verwijderen-hoe-pak-je-dat-aan). A court can order the reviewer's identity handed over (Lycos/Pessers, ECLI:NL:HR:2005:AU4019, not fetched). Keep email addresses, and IP addresses for a short period.

## 4. Copyright and portrait rights

- **No panorama freedom inside museums:** Aw art. 18 covers only works made to stand permanently in public places (https://wetten.overheid.nl/BWBR0001886/2026-01-01, fetched); museums are reportedly not public places [U, secondary: https://download.osmand.net/wiki/Commons:Copyright_rules_by_territory/Netherlands/es]. Art. 18a allows incidental inclusion.
- **Term:** 70 years after the author's death (art. 37). A photo focused on a work by Appel (died 2006) or Picasso (died 1973) infringes.
- **Portraits:** art. 21 blocks publishing unsolicited portraits when the person has a reasonable interest against it; such photos are personal data too.
- **[M] Upload licence in the terms:** the user keeps copyright and warrants they took the photo and hold the rights; grants a non-exclusive, royalty-free licence to store, transcode and display it on the site, ending on deletion (backups excepted); credited by username.
- **[G] Upload checkboxes:** "my own photo", "no recognisable people without consent", "not focused on a protected artwork"; a `museum.photo_policy` field, since house rules are contractual.
- **[M] Takedown** through the Art. 16 form, with categories for copyright, portrait and privacy.
- **[M] Video is a contract risk:** Cloudflare's non-Enterprise CDN terms (updated 28 Sep 2026: https://www.cloudflare.com/service-specific-terms-application-services/) require Stream, R2 or Images for video and large files. Cap video or defer it.

## 5. Other

- **Name:** museum.nl says "Museumkaart" (name and logo) is trademark-protected and its texts and images may not be reused without written permission (https://www.museum.nl/nl/disclaimer). Rename the project; mention the card only descriptively ("Museumkaart geldig") [U]; add a "not affiliated" line; take museum data from Wikidata (CC0) or OSM (ODbL, attribution), not by scraping.
- **KvK:** registration is needed only for independent, paid, regular work (https://kvk.nl/starten/moet-ik-mijn-bedrijf-inschrijven-bij-kvk/). A no-revenue site doesn't qualify.
- **Accessibility:** the EAA covers e-commerce "with a view to concluding a consumer contract" (Art. 3(30), https://www.legislation.gov.uk/eudr/2019/882/chapter/I), so it doesn't apply. **[G]** WCAG 2.2 AA anyway, with axe in Playwright.
- **[G] Disclaimer:** museum information without guarantee.
- **Moderation minimum:** no general duty to monitor (Art. 8), but every notice is handled [M\*]. **[G]** rate limits and pre-moderation of media from new accounts.

## 6. Recommendation

- MVP: privacy page, terms with the upload licence, contact page, report button and notice flow, statements of reasons, export and delete, EXIF stripping, the age gate.
- Treat consumer-review rules as good practice; rename before buying a domain; leave video out of v1 or cap it hard; one paid hour of Dutch legal advice on the DSA and trader questions.

Questions it raised (answered in the interview, A§3): the new name · any revenue ever · delete or anonymise reviews on deletion · video in v1 · which contact address on the privacy page (a home address is a concern for a private person; whether email alone is enough is [U]) · pre- or post-moderation for photos and the retention periods · verified museum accounts or a right of reply.
