# ADR-0018: Wikimedia Commons images, self-hosted with attribution

- **Status:** Accepted (owner, 2026-11-01; P1a plan §1 Q5, Q7, Q8)
- **Date:** 2026-11-02
- **Source:** `docs/plan/phases/p1a-museum-sources.md` §2.9 (the P1a build plan)
- **Amends:** [ADR-0005](0005-museum-data-from-wikidata-and-rce.md), whose "no museum images in v1" line this replaces.

## Context

- A museum page has no image until members add photos (A§12), which takes time in the beta.
- Wikidata's P18 names a Wikimedia Commons file for about 841 Dutch museums (A§7.2). Commons files carry their own licences: often CC BY-SA, sometimes CC0, public domain or CC BY, and sometimes licences we cannot use (non-commercial, no derivatives, fair use).
- The browser makes no third-party requests (invariant 4), so hotlinking `upload.wikimedia.org` is ruled out.
- The P1a sync already reads P18 in its one Wikidata query. sharp (the re-encode) arrives in P3b and the R2 client in P1d.
- Commons reviews its own files. Vandalism would enter through a changed P18 on Wikidata.

## Decision

- **P1a stores the data only.** The query reads P18. The parser keeps only the decoded file name (no `File:` prefix, 1 to 255 characters, none of `#<>[]|{}/` and no control characters) as `museum.commons_file`. The seed sets it directly. After the seed, a new or changed P18 queues as a `museum_change`, so the owner approves it. P1a contacts no Commons host, and its HTTP allowlist holds none.
- **P3b builds the pipeline** as part of the photo pipeline it already builds (one image pipeline, not two). A `commons_image` worker job:
  - Reads the licence, the author, the file page and the file's sha1 from Commons' `imageinfo`/`extmetadata` API.
  - Downloads the file from `upload.wikimedia.org`, through allowlisted hosts with a size cap and no redirect followed.
  - Re-encodes it with the same sharp settings as members' photos (A§12): orientation, all metadata stripped, AVIF and WebP variants, a random key.
  - Publishes the variants to the R2 media bucket. They are served only from `media.<domain>`, never hotlinked.
- **Licence allowlist:** CC0, the Public Domain Mark and public-domain tags, CC BY and CC BY-SA, versions 1.0 to 4.0. Anything else is skipped with a fixed code: NC, ND, GFDL-only, fair use, or an unknown licence.
- **Attribution as plain text** (invariant 5). Commons' `Artist` field is HTML: it is converted to text and never reaches an HTML sink. Under the image the page shows:
  - the author
  - the licence's short name, linked to its deed
  - a link to the file page
  - "resized" (CC BY-SA 4.0 §3(a)(1)(B) asks to indicate modifications)
- **Freshness:** the weekly sync re-checks each published image's licence and sha1 against Commons. A deleted file, a new file version or a licence that leaves the allowlist removes our copy.
- **The owner can hide** any museum's image.
- **Not stored:** Commons' description texts.
- **Egress:** the worker's P3b egress sets gain `commons.wikimedia.org` and `upload.wikimedia.org` (A§17.4).

## Consequences

- Museum pages can show an image from the start of P3b without any third-party request in the browser.
- CC BY-SA images are adapted works (resized and re-encoded). Each needs its attribution and licence link next to it, not on a separate credits page.
- One more weekly check per published image; Commons' API is rate-limited, so P3b paces it and sends the sync's User-Agent.
- The P18 review queue gives the owner one more kind of change to approve after the seed.
- A wrong or vandalised P18 can reach a page only after the owner approves the change, or after the seed. The owner can hide it, and P3b removes our copy when Commons deletes the file.

## Alternatives rejected

- **No images until members' photos (ADR-0005's first answer):** empty pages for months.
- **Hotlinking Commons:** a third-party request from every page view (invariant 4), and no control over what is served.
- **A separate Commons pipeline in P1a:** sharp and the R2 client do not exist yet in P1a, and two image pipelines would drift apart.
