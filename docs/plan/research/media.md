# Research: media, Cloudflare and R2

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report on uploads, storage and processing behind a Cloudflare Tunnel on the Free plan. Outcome: D7, D19, D24, A§12, ADR-0008, ADR-0011, ADR-0014. The plan differs in places: 8 MiB chunks (not 16 MB), photos only until P7, backups to a private R2 bucket; an untrusted member's variants and original stay in quarantine and reach R2 (the media bucket and the backup) only after approval (A§12); the CSP is A§15.6's (`img-src 'self' data: https://media.<domain>`).

## 1. Cloudflare limits

- **Request body cap:** 100 MB on Free; larger requests get a 413. The cap follows the zone's plan; downloads have no size cap (https://developers.cloudflare.com/workers/platform/limits/).
- **Through a tunnel too:** uploads over 100 MB get a 413 before the origin. Community and third-party reports only; the tunnel docs are silent [U] (https://fast.io/resources/cloudflare-upload-limit/, https://lemm.ee/post/16488452).
- **Timeout:** the docs disagree: the current 524 page says 120 or 125 s, older pages 100 s [U]. Only Enterprise can raise it (https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).
- **Cache:** Free caches files up to 512 MB; jpg, webp, avif and mp4 are cached by default (https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).

## 2. Terms (Service-Specific Terms, "last updated 2026-09-28")

- **CDN rule:** paid services "(e.g., the Developer Platform, Images, and Stream)" must be used to serve video and large files; Cloudflare may limit a zone serving video or "a disproportionate percentage of pictures" without them (https://www.cloudflare.com/service-specific-terms-application-services/).
- **2023 change (old section 2.8 removed):** video is fine when "hosted by a Cloudflare service like Stream, Images, or R2"; "Video and large files hosted outside of Cloudflare will still be restricted on our CDN" (https://blog.cloudflare.com/updated-tos/).
- **Reading:** user video through the tunnel from home is not allowed; a site's worth of user photos from home is a grey area; both on R2 is clearly allowed.

## 3. Storage

- **R2 pricing:** $0.015/GB-month; Class A writes $4.50 and Class B reads $0.36 per million. Free per month: 10 GB, 1M writes, 10M reads. No egress fees (https://developers.cloudflare.com/r2/pricing/).
- **EU jurisdiction bucket:** created through the `.eu.` endpoint; the jurisdiction cannot be changed later (https://developers.cloudflare.com/r2/reference/data-location/). Custom domains on EU buckets are not documented [U].
- **Presigned PUT:** up to 7 days, can pin Content-Type, but only on `<acct>.r2.cloudflarestorage.com`, never on a custom domain (https://developers.cloudflare.com/r2/api/s3/presigned-urls/). A browser upload straight to R2 would need that host in `connect-src`: a third-party request.
- **Public bucket on `media.<domain>`:** works when the zone is in the same account, with caching and WAF rules; r2.dev is rate-limited and for development only (https://developers.cloudflare.com/r2/buckets/public-buckets/).
  - CSP: `img-src`/`media-src 'self' https://media.<domain>`.
  - Cookies host-only, so they never reach the media host.
  - Store only files we re-encoded, never raw uploads (rules out HTML/SVG XSS). Add `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` with a Transform Rule.
- **EU alternatives** (backups only: none is a Cloudflare service, so serving from them breaks the CDN terms or the CSP rule):
  - Hetzner: €4.99 or €6.49/month per TB, sources disagree [U] (https://sliplane.io/blog/cheap-object-storage-providers-europe)
  - Scaleway: ~€0.0146/GB-month, 75 GB free egress (https://www.scaleway.com/en/pricing/storage/)
  - Backblaze B2: $6.95/TB from 2026-05-01 (https://costbench.com/software/cloud-infrastructure/backblaze-b2/price-history/)
  - OVH: not checked [U]

## 4. Processing

- **sharp 0.35.5:** Apache-2.0, Node ≥ 20.9, 3 direct dependencies; its prebuilt libvips is LGPL-3.0-or-later (needs ≥ 8.18.7). Metadata, GPS included, is removed by default (https://sharp.pixelplumbing.com/api-output/).
  - Prebuilt formats: JPEG, PNG, WebP, AVIF, TIFF, GIF. **No HEIC**: iPhone photos need conversion in the browser or a rejection message [U] (https://sharp.pixelplumbing.com/install/).
  - `limitInputPixels` ≈ 50 MP and `sharp.concurrency(1)`.
- **ffmpeg:** Debian 13 ships 7.1.5. Distroless has none, so a video worker needs a static build or a hardened debian-slim image.
  - Output: H.264/AAC 720p, CRF 23, `-movflags +faststart`, `-map_metadata -1`, plus a poster frame. HLS is not worth it for clips ≤ 60 s.
  - fluent-ffmpeg is deprecated on npm: spawn `ffprobe`/`ffmpeg` directly.
- **Queue:**

  | Option | Licence | Node | Transitive deps |
  |---|---|---|---|
  | Table + `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY` | – | – | 0 (Kysely supports it) |
  | pg-boss 12.38.0 | MIT | ≥ 22.12 | 22 |
  | graphile-worker 0.18.0 | MIT | ≥ 22.18 | 67 |

- **S3 client:** aws4fetch 1.0.20 has no dependencies but no release since 2024-08; the alternative is ~150 lines of SigV4 on `node:crypto`.
- **Worker resources:** ~2 CPUs and 1.5 GB RAM, one video job at a time; a 60 s clip in tens of seconds on 4 cores [U].
- **Cloudflare Stream:** $5/month per 1,000 minutes stored (prepaid), $1 per 1,000 minutes delivered, encoding free (https://developers.cloudflare.com/stream/pricing/). Playback from `customer-<code>.cloudflarestream.com` breaks the CSP rule.

## 5. Abuse

- **CSAM Scanning Tool:** free on all plans, enabled per zone; checks content served through the cache and blocks matches with a 451 (https://developers.cloudflare.com/cache/reference/csam-scanning/). An R2 custom domain is served through the zone's cache, so probably covered [U]; probably images only [U].
- Also needed: hold uploads of untrusted users for approval, a report button, SHA-256 blocklists of removed files. DSA Art. 16 notice and action applies even to tiny hosts (https://eur-lex.europa.eu/eli/reg/2022/2065/oj).

## 6. Proposed architecture

1. The browser sends chunks (16 MB in the report; the plan uses 8 MiB) to the Hono API through the tunnel, each under the 100 MB cap and the timeout; the API streams them to a quarantine volume.
2. On completion: real type from the bytes (file-type 22.3.0, MIT, 9 transitive), quota check, a job row.
3. The worker re-encodes: photos to AVIF + WebP at 400, 1200 and 2000 px; videos to MP4 + poster.
4. Results go to a public R2 EU bucket at `media.<domain>`, random keys, immutable caching.
5. Originals stay private on the home disk, with an encrypted off-site copy.
6. Items stay hidden until approved.

**Proposed limits:** photo ≤ 25 MB and ≤ 50 MP · video ≤ 60 s and ≤ 150 MB · per review ≤ 10 photos, ≤ 2 videos · per user 30 photos and 5 videos a day, 1 GB in total.

## 7. Cost, year one

Assumes originals of ~4 MB per photo and ~60 MB per video.

| Item | Estimate |
|---|---|
| Originals on the home disk | ~50 GB |
| R2 derivatives | ~9 GB (2.5 GB photos, 6.5 GB video): within the free tier; ~35k writes a year, free |
| R2 total | €0–6 a year, even with originals in a private bucket |
| Off-site backup on B2 or Scaleway | ~€5–10 a year |
| Stream instead of R2 for video | ~$60–110 a year |

## 8. Recommendation

- Upload through our own API in chunks, process at home, serve all user media from R2 (EU) at `media.<domain>`, keep originals at home with a backup.
- Plain `SKIP LOCKED` queue and a hand-written SigV4 client.
- No Stream, no direct-to-R2 presigned uploads.

Questions it raised (answered in the interview, A§3): video at launch or later · R2 at `media.<domain>` acceptable · where the off-site backup lives and how long video originals are kept · HEIC convert or reject · which uploads are held for approval, who moderates · the limits · a non-distroless ffmpeg image.
