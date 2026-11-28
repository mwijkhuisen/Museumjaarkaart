# Runbook: photos (P3b)

For the owner. The operator's view of photo uploads, the `media` container, trust and removal, and the [box] checks to run after the P3b merge. The code wins where this text differs: report the difference. Decisions: ADR-0008 (amended in P3b), A§12, A§16.2.

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

## 1. The path of a photo

1. A member uploads in 8 MiB chunks through the `api` (`POST /api/v1/uploads`, `PUT /uploads/:id/chunks/:n`, `POST /uploads/:id/complete`). The `api` writes to `/srv/mjk/quarantine`, and at `complete` it checks the sha256, the magic bytes (JPEG, PNG or WebP) and the `blocked_hash` table.
2. The worker copies the file into a task directory under `/srv/mjk/media-work` and hands it to the `media` container. `media` is the only process that decodes the image. It has no network, no secret, no database login and no environment (owner Q1).
3. `media` decodes once into raw sRGB and writes AVIF and WebP at 400, 1200 and 2000 px (and the source width when that is smaller). The worker reads the outputs back through the task directory's descriptor and deletes the task.
4. The photo stays in quarantine as "wacht op controle" (pending). Its author sees a preview from the `api` (`GET /uploads/:id/preview?w=400|1200`: `private, no-store`, `nosniff`, a sandbox CSP); anyone else gets a 404.
5. `media_publish` runs only for a trusted member's photo that is attached to a review. It puts the variants on R2 under a random key (`Cache-Control: public, max-age=31536000, immutable`) and the original into `/srv/mjk/originals` (restic), then approves. A failure undoes what that run put.

Where the files live:

| Place | Holds |
| --- | --- |
| `/srv/mjk/quarantine` | uploads and their pending variants; the `api` and the worker write it |
| `/srv/mjk/media-work` | one task at a time, for `media`; empty when idle |
| `/srv/mjk/originals` | the original of a published photo; restic backs it up (`docs/runbooks/backup.md`) |
| `media.<domain>/p/<key>/<width>.(avif|webp)` | published variants (R2) |

## 2. Trust and untrust a member

Until P3c has its trust rule and user screens, the owner sets trust by hand:

```bash
mjkc --profile tools run --rm admin user trust <handle>
mjkc --profile tools run --rm admin user trust <handle> --revoke
```

Exit 0 done · 64 usage (a bad handle) · 66 unknown handle · 78 config. It writes one `audit_log` row (`user.trust` or `user.untrust`), never an address. Revoking does not touch published photos. Photos already pending stay pending after a trust (owner N2): a photo is published when it is attached to a review by a trusted member, so an older pending one waits for P3c's queue.

## 3. "Wacht op controle"

An untrusted member's photo, and a trusted member's photo that is not yet attached to a review, shows "wacht op controle" to its author only. There is no moderator queue until P3c: such a photo stays pending. A photo that is never attached to a review is removed after 7 days (owner N1).

## 4. Removing a photo today

The member removes their own photo with `DELETE /api/v1/media/:id`. Deleting a review removes its photos too. Both mark the photo `removed`; the worker then deletes the R2 keys, the files and the row (`media_delete`; the 10-minute purge re-queues one that was missed). There is no moderator route until P3c. For an urgent removal before then, ask the member to delete it, or follow A§12's urgent-removal rule (purge the URL in Cloudflare's dashboard). A deleted variant leaves `media.<domain>` within the 4 h edge TTL.

## 5. The `blocked_hash` table

`blocked_hash` holds sha256 values of files that must never be accepted again. P3c's moderation fills it; `complete` reads it (`mjk_api` has `SELECT` only). Until P3c it is empty.

## 6. The `media` container's health

```bash
mjkc ps media                                  # healthy while its heartbeat is fresh
mjkc logs --since 1h media                     # fixed codes only
docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}}' mjk-media-1
```

Its log lines are fixed codes, never a file name or content: `media_task_done` (with its duration), `media_task_failed` (with a `code`), `media_task_aborted` (a stop during a task; the worker retries it), `media_task_write_failed` (the worker gave up first, or the mount is full), `media_workdir_unreadable` (the mount is missing or unreadable) and `media_watchdog` (a task ran past its time and the process exited, so Docker restarted it). A photo that fails ends `failed` with a code and its quarantine file is deleted. A `failed` photo is the member's to re-upload; a rising `media_watchdog` or restart count is a bug to report with the code, not the file.

The limits are 768m, 1.0 CPU, 256 pids and a 64 MB file-size ulimit. The disk guard reads `/srv/mjk/state/guard/disk` (`docs/runbooks/incident.md` §4): under 10 % free, or a file older than 30 minutes, makes `POST /uploads` answer 503.

## 7. [box] checks for the owner

Run after the first P3b deploy, with one real photo published from a trusted account. Replace `<key>` and `<id>` with the photo's.

1. The headers on the media host. Expect `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox` and `cache-control: public, max-age=31536000, immutable`:
   `curl -sI https://media.<domain>/p/<key>/1200.avif`
2. The original is in the backup. Expect a line:
   `restic ls latest | grep originals/<id>`
3. Time and memory of a 24 MP phone photo. Start the stats, upload the photo, and write the time per photo and the peak memory into A§17.2:
   `docker stats mjk-media-1`
4. The bucket's `r2.dev` URL is off. Expect no content (a 404 or a refusal):
   `curl -sI https://pub-<id>.r2.dev/<key>`
5. A deleted variant is gone from `media.<domain>` within the 4 h edge TTL: delete the photo, then `curl -sI` its URL after 4 h and expect 404.
6. The iPhone check: choose a photo from the library on an iPhone. The file input must hand over a JPEG: iOS should convert HEIC because the input accepts only JPEG, PNG and WebP [U: WebKit's source and a 2025 test say so; this check proves it, A§12].
7. A slow-link upload through the tunnel: upload a 20 MiB photo from a phone on a slow connection. The 8 MiB chunks must finish inside Cloudflare's request timeouts (about 100 s) and under its 100 MB body cap. Note the link speed and the result.
