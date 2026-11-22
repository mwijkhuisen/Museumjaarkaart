# Runbook: the map tiles refresh

For the owner. It covers the quarterly `tiles_refresh` worker job (A§15.3, ADR-0014): the Protomaps extract of the Netherlands, its upload to R2, the rollback and the P1d [box] checks. The code wins where this text differs: report the difference.

`<domain>` is the public domain (`MJK_DOMAIN`). `mjkc` is the compose shorthand of `docs/runbooks/install.md` §6:

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

## 1. What the job does

- **When:** the first Sunday of January, April, July and October at 02:23 Europe/Amsterdam (`apps/server/src/worker/schedule.ts`, croner `23 2 * 1,4,7,10 0#1`), enqueued by the `worker` unless one is already queued or running. By hand: §4. It is clear of the Tuesday 03:17 museum sync and the 01:43 backup.
- **One run:**
  1. It reads `https://build-metadata.protomaps.dev/builds.json` and takes the newest daily build whose key is `20YYMMDD.pmtiles` and whose tiles version has the major our style draws (4). Protomaps keeps a build for one week only. The source is `https://build.protomaps.com/<key>`, built from that key and nothing else.
  2. It reads `tiles/current.json` in the bucket. If the newest build is not later than the one in use (so a stale or hostile `builds.json` never rolls the map back), or is the one a rollback moved away from, the job ends (`tiles_up_to_date`): nothing is extracted. A build is never extracted twice, because its file is immutable.
  3. It empties `/srv/mjk/tiles-build` and runs `pmtiles extract <source> /srv/mjk/tiles-build/nl-<build>.pmtiles --bbox=3.2,50.7,7.3,53.7` (the box of `NL_BOX`: west, south, east, north; the build's full zoom range, owner Q1). go-pmtiles 1.31.2 has no resume and follows redirects to any host, so nothing it leaves is trusted.
  4. It checks the file before any upload: a regular file, a PMTiles v3 header, vector tiles, gzip or no compression, zoom from 0, bounds inside the box (0.01° slack), every section inside the file, and a size between 100 MiB and 4 GiB. Else `tiles_bad_file` (the log line carries the reason: `size`, `magic`, `version`, `type`, `compression`, `zoom`, `bounds`, `truncated` or `not_file`).
  5. It uploads `tiles/nl-<build>.pmtiles` (`Content-Type: application/vnd.pmtiles`, `Cache-Control: public, max-age=31536000, immutable`; multipart in 32 MiB parts, aborted on a failure), asks for its size and compares it.
  6. Only then it writes `tiles/current.json` (`{"file":"nl-<build>.pmtiles","previous":"<the file that was current>"}`, `Cache-Control: public, max-age=300`), and deletes the file that was `previous` before (two refreshes back). The map reads `current.json` first, so the flip is the moment a new extract goes live.
  7. In a `finally`, on success, failure and abort alike, it empties `/srv/mjk/tiles-build`.
- **What stays in the bucket:** the current file and the one before it, for a rollback (owner Q3). At most three tile files exist for a moment, during step 6.
- **The worker** runs one job at a time; while this one runs (an hour or more) a museum sync waits. The worker touches the job's lease every 30 seconds, so a long run is not taken over or reaped while the worker lives (§7).
- **Config at run time:** the job reads `MJK_R2_ENDPOINT`, `MJK_R2_BUCKET_MEDIA` and the file secret `r2_media_rw` when it runs, not when the worker starts. Without `MJK_R2_ENDPOINT` or `MJK_R2_BUCKET_MEDIA` the worker still runs its other jobs and the tiles job fails at once with a `store_*` code (§6). The secret file is different: Compose will not start the `worker` without it (§2).
- The log has fixed codes and counts only (`tiles_build_found`, `tiles_up_to_date`, `tiles_published`, `tiles_extract_failed`, `tiles_bad_file`, `tiles_old_delete_failed`, then the worker's `job_done`, `job_retry`, `job_failed`): never a key, a URL or the credentials.

## 2. Prerequisites (owner action A2)

**On a host that already runs P1e, items 1 to 4 come first, before the `mjk-install` (and so the deploy) that brings P1d.** Its timers are on, and Compose cannot create the `worker` without `/etc/mjk/secrets/r2_media_rw`: `mjk-update` refuses the deploy (`config_missing: secret file(s) missing: …`, exit 78, the running stack untouched) until the file exists.

1. **The bucket.** In the Cloudflare dashboard, R2 → Create bucket `mjk-media`, jurisdiction European Union, public through the custom domain `media.<domain>` only, with the `r2.dev` public URL off (`docs/runbooks/cloudflare.md` §4). The jurisdiction cannot change later.
2. **CORS**, bucket settings → CORS policy (JSON editor): only `https://<domain>` may read, only with `GET` and `HEAD`.

```json
[
  {
    "AllowedOrigins": ["https://<domain>"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

   `range` is for browsers that preflight a `Range` request, `ETag` is what pmtiles checks between two range reads of one file. Both are [U] until the [box] run in §8 has shown a map load from `https://<domain>`.
3. **The token.** R2 → Manage API tokens → Object Read & Write, scoped to the one bucket `mjk-media`, never account-wide. Write it as an AWS credentials file (the format of `r2_backup_put`) into `/etc/mjk/secrets/r2_media_rw`, owner `root:63009`, mode `0440`, as `docs/runbooks/install.md` §4 describes. Compose will not start the `worker` without the file: on a first install `mjk-install` lists it as missing and leaves the timers off; on a P1e host `mjk-update` refuses to deploy until it is there.
4. **Config.** `/etc/mjk/mjk.env` has `MJK_R2_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com` (the backup uses it too) and `MJK_R2_BUCKET_MEDIA=mjk-media`. Recreate the worker so it reads them: `mjkc up -d --force-recreate worker`.
5. **The host.** `/srv/mjk/tiles-build` exists (`mjk-install` makes it `63532:63532 0700`) on a disk with room for **twice the file**: go-pmtiles writes a temporary file as large as the extract in the same directory (`TMPDIR`), and then the output. Check `df -h /srv/mjk/tiles-build` against a ceiling of 4 GiB.
6. **The limits.** The worker container has `ulimits: fsize` 4.4 GB (a runaway extract fails its write instead of filling the disk), a 768 MiB memory limit and `GOMEMLIMIT` 300 MiB for go-pmtiles. If the [box] run is killed for memory (`mjkc ps worker`, `docker inspect` shows `OOMKilled`), raise the limit in `deploy/compose.yaml` in a PR.

## 3. Watching a run

```bash
mjkc logs --since 3h worker | grep -E 'tiles_|job_'        # the fixed codes above, with the build date and counts
mjkc exec -T db psql -X -U postgres -d mjk -c "SELECT id, kind, state, attempts, last_error, locked_at, finished_at FROM job WHERE kind LIKE 'tiles_%' ORDER BY id DESC LIMIT 5"
ls -l /srv/mjk/tiles-build                                  # the file grows during the extract, and is empty again afterwards
```

`state` is `queued`, `running`, `done` or `failed`; `last_error` is the fixed code of the last failed try (§6). A retry waits 15 minutes, then 30; a `tiles_refresh` job tries 3 times in all (the schedule and `admin` both set it); a `tiles_rollback` tries once (§5).

## 4. A run by hand

```bash
mjkc --profile tools run --rm admin tiles refresh      # prints "tiles_refresh queued", or says one is already queued or running
```

The `admin` role runs as `mjk_api`, which may only insert the job; it holds no R2 secret. The `worker` picks the job up within a second (NOTIFY) and runs it with its own secrets. Do not start one while a rollback is queued or running (they would both write `current.json`).

## 5. Rolling back

When the new extract is wrong (a missing layer, a blank map), point `current.json` back at the previous file:

```bash
mjkc --profile tools run --rm admin tiles rollback     # queues tiles_rollback
mjkc logs --since 5m worker | grep -E 'tiles_|job_'    # tiles_rolled_back, then job_done
```

- It swaps `file` and `previous` in `tiles/current.json`; both files stay in the bucket. It first checks that the previous file still exists, else `tiles_no_previous`.
- Browsers read `current.json` with a 5 minute cache, so a rollback is visible within about 5 minutes (a Cloudflare edge copy ages out on the same clock).
- The next refresh will not extract the build that was rolled back from (`tiles_up_to_date`); a newer build goes through and deletes the bad file, because it is then two back. To get a bad build out sooner, wait for the next build date or ask for a change in a PR.
- A second `rollback` swaps them again.
- **A rollback runs once, never retried:** it is a swap, so a retry after an answer that was lost (a timeout, an update during the write) would swap back. When it ends `failed`, look first which file is live, and queue it again only if `file` is still the bad one:

```bash
curl -s https://media.<domain>/tiles/current.json   # {"file":"nl-…","previous":"nl-…"}; up to 5 minutes old
```

## 6. The codes

Every code is fixed (`^[a-z_]{1,40}$`) and stored in `job.last_error`. "Final" fails the job at once; the others are retried (3 tries in all for a refresh; a rollback is never retried, §5).

| Code | Meaning | What to do |
|---|---|---|
| `tiles_builds_unavailable` | the build list did not answer 200 in 60 s, or the network failed | wait for the retry; check `curl -sI https://build-metadata.protomaps.dev/builds.json` from your machine |
| `tiles_builds_invalid` (final) | the list is not a JSON array, or over 1 MiB | open an issue: Protomaps changed the list |
| `tiles_no_build` (final) | no build with a real date, not after tomorrow, and tiles major 4 | the list changed or Protomaps moved to major 5: open an issue (the style needs a rebuild for a new schema) |
| `tiles_extract_failed` | go-pmtiles exited non-zero, was killed (the 2 hour limit, an abort, the OOM killer), or could not start. The log line has `status` (the exit status) and `signal` | `status` 1 is a failed run (network, a full disk, `fsize`); `status: null` with `signal: "SIGKILL"` is a kill: the 2 hour limit (a stalled or slow source; a 1–2 GB extract in range reads should take well under it [U box]) or memory (§2 item 6, `docker inspect` shows `OOMKilled`); both null is a binary that could not start. Retried; at the next schedule otherwise |
| `tiles_bad_file` (final) | the extract failed a check of §1 step 4; the log line `tiles_bad_file` has the reason | `size`: measure with `ls -l` on a manual run; the floor (100 MiB) or the ceiling (4 GiB) in `apps/server/src/tiles/header.ts` may be wrong for the box [U]. The other reasons mean a broken or unexpected file |
| `tiles_size_mismatch` | the stored object has another size than the file | retried; a persisting one is an R2 or network problem |
| `tiles_current_invalid` (final) | `tiles/current.json` is not `{"file","previous"}` with names `nl-YYYYMMDD.pmtiles` | fix or delete the object in the dashboard (deleting it makes the next run a first run), then rerun |
| `tiles_no_previous` (final) | a rollback with no previous file, or the previous file is gone | nothing to roll back to; run a refresh |
| `tiles_build_dir` (final) | `/srv/mjk/tiles-build` is missing or unreadable in the worker | `mjk-install` makes it; check the mount in `deploy/compose.yaml` |
| `tiles_aborted` | the worker was stopped (an update) during the job | the job runs again by itself; the build directory is emptied |
| `store_secret_missing`, `store_secret_invalid` (final) | `/run/secrets/r2_media_rw` cannot be read or has no `[default]` key | §2 item 3, then `mjkc up -d --force-recreate worker` |
| `store_endpoint_invalid`, `store_bucket_invalid` (final) | `MJK_R2_ENDPOINT` is not an https origin, or `MJK_R2_BUCKET_MEDIA` is not a bucket name | §2 item 4 |
| `store_denied` | R2 answered 401 or 403: a wrong or revoked token, or a token scoped to another bucket | rotate the token (`docs/runbooks/secrets-rotation.md` §3b) |
| `store_unavailable`, `store_timeout`, `store_aborted` | the network, a 5xx or 429, a timeout of 5 minutes on one part | retried |
| `store_rejected`, `store_bad_response`, `store_too_large`, `store_file_unreadable` | R2 or the file answered something unexpected | open an issue with the code |
| `unknown_kind`, `internal` | the worker has no such handler; any other error (its message is never stored) | an old worker image, or a bug: open an issue |

A failure never changes `current.json`: the map keeps the old extract. After a final failure the job stays `failed` until the next schedule or a run by hand. A leftover `tiles/nl-<build>.pmtiles` that no `current.json` names (a failure after the upload) is overwritten by the next refresh of that build or can be deleted in the dashboard. A refresh whose `current.json` write committed but whose answer was lost ends `tiles_up_to_date` on its retry, so the file two back is never deleted: an orphan of 1–2 GB that no pointer names (an accepted risk, ADR-0014). Find one by hand: in the dashboard (R2 → `mjk-media` → `tiles/`), every `nl-*.pmtiles` that is neither `file` nor `previous` in `curl -s https://media.<domain>/tiles/current.json` is an orphan; delete it there. An unfinished multipart upload is aborted by the job; if the worker was killed in the middle, set a lifecycle rule on `mjk-media` that aborts incomplete multipart uploads after 7 days.

## 7. The lease

A job's `locked_at` is its lease: another worker may take over a `running` job whose lease is more than 30 minutes old, and `reap` fails one with no attempts left (`lease_expired`). The extract and upload of 1–2 GB [U] outlast that, so the worker refreshes `locked_at` of the job it runs on its 30 second heartbeat (guarded by `locked_by`). Only a worker that is gone (a crash, a lost database) loses its lease, and then the job is taken over after 30 minutes as before. In that case the extract starts again from nothing: the new run empties the build directory first.

## 8. The P1d [box] checks (owner)

Run on the VM once the prerequisites of §2 are done and the stack is deployed from the P1d image.

1. **Run the job and wait for it.**

```bash
date; mjkc --profile tools run --rm admin tiles refresh
mjkc logs -f worker | grep -E 'tiles_|job_'        # until job_done (or job_failed with its code)
```

   Note the build date (`tiles_build_found`), how long it took (`job_done` has `ms`), and `df -h /srv/mjk/tiles-build` during the run.
2. **The size.** From your workstation with the bucket token (or in the dashboard): the size of `tiles/nl-<build>.pmtiles`. A§15.3 expects ~1–2 GB [U]; write the measured size into A§15.3 and tell the lead. If it is far over 2 GB, drop the top zoom level (a `--maxzoom` argument in a PR; MapLibre overzooms).
3. **`current.json`:**

```bash
curl -sS https://media.<domain>/tiles/current.json
# {"file":"nl-<build>.pmtiles","previous":null}
```

4. **A range request, cold and warm** (owner Q7: no Cache Rule on `tiles/*` first). Run it twice, a minute apart, and record both outputs:

```bash
curl -sS -o /dev/null -D - -r 0-1023 https://media.<domain>/tiles/nl-<build>.pmtiles
```

   Record the status (206 expected), `content-range` (`bytes 0-1023/<size>`), `content-type`, `cache-control` (`public, max-age=31536000, immutable`) and `cf-cache-status` (`MISS` or `DYNAMIC` cold, `HIT` warm if Cloudflare caches ranges of this object). The answer goes into A§15.3 and ADR-0014. If the cold request is slow or `cf-cache-status` stays `DYNAMIC`/`MISS` on a warm one, tell the lead before adding a Cache Rule for `tiles/*` (cloudflare.md §5).
5. **CORS:**

```bash
curl -sS -o /dev/null -D - -H 'Origin: https://<domain>' -r 0-1023 https://media.<domain>/tiles/nl-<build>.pmtiles | grep -i -E '^(HTTP|access-control|etag)'
curl -sS -o /dev/null -D - -H 'Origin: https://example.org' -r 0-1023 https://media.<domain>/tiles/nl-<build>.pmtiles | grep -i -E '^(HTTP|access-control)'
```

   The first answers `access-control-allow-origin: https://<domain>` and an `etag`; the second has no `access-control-allow-origin`.
6. **Idempotence:** run `tiles refresh` again: the log shows `tiles_up_to_date` and `job_done` within seconds, and nothing is extracted. A refresh on a later date (the next quarter) leaves two files and the first one stays as `previous`.
7. **A rollback drill** after the second refresh exists: `tiles rollback`, check `current.json` names the older file, then `tiles rollback` again to restore it.
8. Check `ls /srv/mjk/tiles-build` is empty and `mjkc ps worker` is healthy.

Put the outputs in the P1d PR (job log lines, size, the two `curl` outputs).
