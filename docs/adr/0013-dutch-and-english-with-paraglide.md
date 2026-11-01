# ADR-0013: Dutch and English with Paraglide

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The audience is Dutch card holders, plus expats and visitors who use the card too (D2). Wikidata gives Dutch and English labels and descriptions (A§7.2).
- Waterheight runs Paraglide 2 with a `check-i18n` script; F1 is English only.
- Public pages are server-rendered and cached at the edge (ADR-0009), so the language has to be part of the URL.

## Decision

- **@inlang/paraglide-js 2.29.1** with **@inlang/plugin-message-format 4.5.4**, as in Waterheight. The plugins load from `node_modules`, never from a CDN. Pins are re-checked against the 7-day rule when installed.
- **NL by default at `/`, EN under `/en/`** (A§15.2). The locale comes from the URL only: no cookie and no `Accept-Language` redirect. `hreflang` links the two versions.
- Messages live in `apps/web/messages/{nl,en}.json`. `check-i18n` (part of `pnpm check`) requires the same keys in both, each non-empty, and no hard-coded UI string in a `.tsx` file.
- Emails use the member's `locale` setting (A§10). The brand comes from config and messages (ADR-0006).
- Legal and trust pages (privacy, terms, contact, "Hoe wij reviews controleren") exist in both languages.
- **Members write in any language.** Their text is shown as written and never machine-translated (that would be a third party).
- Museum names and descriptions use `name_en` / `description_en` where Wikidata has them, otherwise the Dutch.

## Consequences

- Every UI string is written twice; `check-i18n` blocks a merge that misses one.
- Waterheight's gotchas apply: never index the Paraglide `m` namespace by a computed key, and compile with a strategy that sets no cookie.
- `sitemap.xml` lists twice the URLs, and the edge cache holds one entry per language.

## Alternatives rejected

- **Dutch only:** leaves out expats and visitors.
- **English only:** the main audience is Dutch.
- **Locale from a cookie or `Accept-Language`:** the same URL would vary per visitor, which breaks cacheable anonymous HTML and `hreflang`.
