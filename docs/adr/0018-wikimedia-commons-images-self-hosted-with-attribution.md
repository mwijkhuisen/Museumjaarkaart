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

## Amended in P3b (2026-11-28)

- **The rendering is 1920 px** (owner Q8): the job asks `imageinfo` for `iiurlwidth=1920` and downloads that rendering; the original only when it is smaller than 1920 px.
- **The allowlist stays two hosts.** `imageinfo` names most `thumburl`s on `thumb.wikimedia.org` (P3b's recording, 2026-11-27); the same path is served by `upload.wikimedia.org`, so the job rewrites the host and downloads from `upload.wikimedia.org` (`apps/server/src/museums/commons/api.ts`). The hosts the job may contact stay `commons.wikimedia.org` and `upload.wikimedia.org`.
- **Its own weekly check:** `commons_sync` runs Thursday 04:11, apart from the museum sync, and queues `commons_image` per changed museum, 10 s apart, so the `media` role takes them one by one.
- **Our copy moves before the old one goes:** a new image is put under a new random key and the row points at it before the previous image's objects are deleted, so a page never names a deleted object.
- **A row never names a deleted object:** a museum that lost its file loses its row first, then the objects (P3b review L6). **Accepted residual:** an object delete that fails after the row changed (here, and in `writeRow` when a new image or a skip replaces an old one) leaves those objects on R2 under their random 128-bit key, which no row or page names any more and no retry finds. Anyone who saw the URL before can still fetch them, and Cloudflare may serve them for up to the 4 h edge TTL. The upgrade path, if it matters (a takedown), is a durable delete list that the job empties.
- **Skipped, with a fixed code:** a file whose `extmetadata.Restrictions` holds anything (personality rights, a trademark) is `commons_restricted`, asked again each week; a rendering that does not decode is `commons_decode_failed`, fetched again only for a new sha1 or file (P3b reviews). Whether `pd` should need more than the `License` value (US-only tags such as `PD-US` or `PD-USGov` may not be free in the Netherlands) is open for the owner (security review L4).
- **Hiding is the admin CLI's** (`admin museum image hide|unhide`, as `mjk_api`, which holds no R2 key): the image leaves the page at once and the worker deletes the objects (A§12).
