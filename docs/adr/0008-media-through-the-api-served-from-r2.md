# ADR-0008: Media: uploads through the API, derivatives served from R2 (EU)

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** at the P7 gate (owner action A12), or when Cloudflare changes its service-specific terms again.

## Context

- Members add photos to reviews from the beta on; video follows only if beta users ask for it (D7, D19).
- Cloudflare, checked 2026-11-01 (`docs/plan/research/media.md`):
  - A 100 MB request-body cap on the Free plan, which also hits tunnel uploads [U], and a 100–125 s timeout [U].
  - The Service-Specific Terms (last updated 2026-09-28): video and "a disproportionate percentage of pictures" need a Cloudflare service such as R2, Images or Stream; video hosted outside Cloudflare stays restricted on the CDN.
  - R2: no egress fees; 10 GB, 1M writes and 10M reads free per month; an EU jurisdiction bucket (fixed at creation); a public bucket on a custom domain in the same account. Presigned URLs work only on `<account>.r2.cloudflarestorage.com`. Custom domains on EU buckets are not documented [U].
  - Stream plays from `customer-<code>.cloudflarestream.com`.
- The browser talks only to our own hosts (A§16.1). sharp 0.35.5's prebuilt libvips has no HEIC.

## Decision

- **Upload through our API** (A§12): `POST /api/v1/uploads` (declares kind, size and type) → `PUT …/chunks/<n>` in 8 MiB chunks → `POST …/complete`. The `api` streams to `/srv/mjk/quarantine`, checks size, sha256, magic bytes (`file-type` 22.3.0: JPEG, PNG, WebP), quotas and `blocked_hash`, then enqueues a job.
- **Process on the VM:** the worker (sharp 0.35.5, `limitInputPixels` ≈ 50 MP, `sharp.concurrency(1)`) applies orientation, strips all metadata (EXIF, GPS) and writes AVIF and WebP at 400, 1200 and 2000 px under a random 128-bit key.
- **Serve from R2:** a `media_publish` job uploads the variants with our own SigV4 client (~150 lines, `node:crypto`, no AWS SDK) to the public EU bucket `mjk-media` at `media.<domain>`, with the exact `Content-Type` and `Cache-Control: public, max-age=31536000, immutable`; an untrusted member's photo only after approval. Until then its variants stay in `/srv/mjk/quarantine/<id>/v/`, and only its author and moderators see them, through `private, no-store` preview routes on the `api` (A§12, A§14). A Transform Rule adds `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; a Cache Rule on `media.<domain>/p/*` sets an Edge TTL of 4 h [U]; the bucket's `r2.dev` URL is off; CORS allows `GET` from `https://<domain>` only (owner action A2).
- **Raw uploads are never served.** Originals stay private in `/srv/mjk/originals` and go into restic (ADR-0011).
- **Limits:** a photo ≤ 25 MB and ≤ 50 MP; ≤ 10 per review, ≤ 30 per day and 1 GB in total per member. The file input accepts JPEG, PNG and WebP, so iOS hands over a JPEG [U P3b].
- **Video (P7):** the same chunked upload; a separate `mjk-media` ffmpeg worker image (hardened Debian slim, not distroless [U]); H.264/AAC 720p with `+faststart` and a poster frame; served from R2 with range requests.
- Only the worker holds `r2_media_rw` (GID 63009), an Object Read & Write token scoped to `mjk-media` only (A§17.3). The CSP names `https://media.<domain>` in `img-src`, and in `connect-src`/`media-src` where tiles and video need it (A§15.6).
- Pins are re-checked against the 7-day rule when installed.

## Consequences

- The browser only meets `<domain>` and `media.<domain>`. The tunnel carries uploads but never media downloads.
- Within or near R2's free tier in year one: ~9 GB of derivatives with video, ~50 GB of originals at home [U] (A§19).
- Deleting a photo (by the member, a moderator or account deletion) deletes the variants and the original at once. The edge copy expires within the 4 h edge TTL. Urgent removals (CSAM, Art. 18, a court order) are also purged by URL in the dashboard (runbook `takedown-and-purge`). A scoped purge token for the worker stays [U P3c].
- A second Cloudflare product in the stack (accepted, D7), and a Transform Rule to keep in the runbook.
- Open for P3b: sharp's `allowBuilds` decision and glibc in distroless [U].

## Alternatives rejected

- **All media from the home VM through the tunnel:** Cloudflare's terms (2026-09-28) restrict video and disproportionate images not hosted on a Cloudflare service, and the home line would carry every view.
- **Presigned direct-to-R2 `PUT`:** works only on `r2.cloudflarestorage.com`, which breaks the no-third-party-requests rule, and stores a file before our checks run.
- **Cloudflare Stream:** playback from `cloudflarestream.com` breaks the same rule, and it costs ~$60–110 a year.
- **EU S3 providers (Hetzner, Scaleway, Backblaze B2) for serving:** not Cloudflare-hosted, so video through the CDN stays restricted, and their own hostnames break the rule.
- **aws4fetch or the AWS SDK:** aws4fetch has had no release since 2024-08; the SDK is large for a handful of calls.
