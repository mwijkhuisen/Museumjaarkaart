# Runbook: update and rollback

For the owner. How new images reach the VM, how a bad one is rolled back, and how you prove it (P1e criterion 8). The code wins where this text differs: `deploy/bin/mjk-update` and `deploy/bin/mjk-tick`.

All commands run as root on the VM. Shorthand (as in `docs/runbooks/install.md` §6):

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

**Before the deploy that brings P3b (an existing host):** run `mjk-install` first. It creates `/srv/mjk/state/guard` (root 0755), installs the new units and starts `mjk-egress.service` (the worker's egress set, after the firewall unit and never before Docker). The `worker` and the new `media` container share the tmpfs volume `mjk_media_work` (256 MB, A§17.1), which Compose creates itself. A host that ran an earlier P3b build has an unused `/srv/mjk/media-work` directory: once the deploy is healthy, it may be removed (`rm -r /srv/mjk/media-work`, as root; it holds only task directories that ended). The disk file moves to `state/guard/disk`; the old `state/disk` is stale and may be removed. Services to check after the deploy are now seven: `media` joins `db`, `api`, `ssr`, `worker`, `caddy` and `cloudflared` (`docs/runbooks/photos.md`).

**Before the deploy that brings P1d (an existing P1e host):** create the secret file `/etc/mjk/secrets/r2_media_rw` and set `MJK_R2_BUCKET_MEDIA` in `mjk.env` first (`docs/runbooks/tiles-refresh.md` §2), then run `mjk-install`. Compose cannot create the `worker` without the file, and a rollback keeps the new compose file, so `mjk-update` refuses the deploy until every secret file of the compose file exists (step 2b).

## 1. How an update happens (A§17.5)

- The `release` job (environment `production`, you approve it) builds `ghcr.io/mwijkhuisen/mjk-server`, `mjk-web` and `mjk-backup` from one commit, labels all three `org.opencontainers.image.revision=<git sha>` and pushes `:main` and `:sha-<git>`. GitHub holds no credential for the VM.
- `mjk-update.timer` runs `/usr/local/bin/mjk-update` every 10 minutes (and 3 minutes after boot). The script:
  0. checks `/etc/mjk/mjk.env` again with `mjk-envcheck`, the same rules as `mjk-install` (root:root 0644 or 0640, allow-listed keys only): an edit since the last install that breaks them is exit 78 `config_invalid`, naming the key or line, never a value;
  1. takes the deploy lock exclusive, without waiting (held by `mjk-tick` or the nightly backup, which take it shared, means exit 0 and nothing done); refuses with exit 1 when `table inet mjk` is not loaded, and checks that again (with `firewall-stopped`) before each compose step;
  2. pulls the three `:main` images (300 s each) and records each by digest (`repo@sha256:…`, never a tag); waits (exit 0) while the three revision labels differ, because a release is still being pushed; stops when the digests and the compose file's sha256 equal `current.env`; refuses a set that equals `failed.env`. A compose file that `mjk-install` changed is deployed with the same images (`compose file changed since current.env`);
  2b. checks that every secret file the compose file names (all profiles) exists: a missing one is exit 78 `config_missing: secret file(s) missing: <paths>`, with the running stack, `current.env` and `failed.env` untouched, so the next run deploys once the files are there;
  3. runs `migrate` (profile `jobs`, 300 s);
  4. runs `up -d --remove-orphans` (600 s);
  5. waits until every daemon is healthy (180 s), then smoke-tests `http://127.0.0.1:8280` with `Host: <domain>`: `/api/v1/healthz`, `/`, `/musea` and one museum page when the catalogue has one;
  6. only after all that, replaces `current.env`; on any failure writes `failed.env`, puts the images of `current.env` back (600 s) and waits until they are healthy (without a `current.env` it stops the stack). A failed compose step logs compose's last error lines as `compose: …`;
  7. after a success, removes the local references of `ghcr.io/mwijkhuisen/mjk-*` that `current.env` does not use (`old images: N reference(s) … removed`). Other projects' images are never touched.
- Every step is bounded; the worst case is about 57 minutes, under the unit's `TimeoutStartSec=65min`.
- State, all in `/srv/mjk/state`: `current.env` (the three refs of the last good deploy and `MJK_COMPOSE_SHA256`), `failed.env` (the same for the last failed one), `guard/disk` (written by `mjk-tick`; a P3b install no longer writes `state/disk`, and the old file is stale and may be removed), `firewall-stopped` (see `docs/runbooks/incident.md`).
- **A migration must work with the previous image** (expand now, contract in a later release): a rollback restores the old images but never runs `down`. P1e itself adds no migration.

## 2. Watching and forcing

```bash
systemctl list-timers 'mjk-*' --no-pager
journalctl -u mjk-update.service -n 80 --no-pager      # fixed messages: image refs, digests, container names; no environment, no body
cat /srv/mjk/state/current.env; cat /srv/mjk/state/failed.env 2>/dev/null
systemctl start mjk-update.service                     # run it now, instead of waiting
mjkc ps
```

The log lines to know: `waiting: the images' revision labels differ`, `up to date: the digests and the compose file equal current.env`, `compose file changed since current.env`, `smoke test passed`, `deployed: …`, `deploy FAILED: <migrate_failed|up_failed|not_healthy|smoke_failed>`, `REFUSED: this set of images failed before`, `no_revision_label`, `pull_failed`, `config_missing: secret file(s) missing`, `firewall_missing`, `firewall_stopped`, `compose: …` (compose's own error lines after a failed step).

## 3. The rollback proof (criterion 8, [box])

The test needs an image that pulls fine and never becomes a working server. The web image is that image: it carries Caddy, so `migrate` fails as the first step of a deploy. Take your last good web ref and pass it as the server:

```bash
cp /srv/mjk/state/current.env /root/current-before.env
WEB=$(sed -n 's/^MJK_WEB_IMAGE=//p' /srv/mjk/state/current.env)
mjk-update --server "$WEB"; echo "exit $?"
```

Expected:
- the output ends with `deploy FAILED: migrate_failed`, `rolling back to the images of current.env` and `rollback done: the previous images are healthy`; exit 1;
- `cmp /root/current-before.env /srv/mjk/state/current.env` is silent: `current.env` is unchanged;
- `/srv/mjk/state/failed.env` exists and names the web image as `MJK_SERVER_IMAGE`;
- `mjkc ps` shows every daemon healthy and `curl -s -H "Host: <domain>" http://127.0.0.1:8280/api/v1/healthz` answers, so the site stayed up.

Then clear the marker (the automatic run would otherwise refuse that same set, which is the point of `failed.env`; here the set is only a test):

```bash
rm /srv/mjk/state/failed.env
mjk-update          # normal run again: "up to date" or the next release
```

`mjk-update --server <ref> --web <ref> --backup <ref>` deploys exactly those images (drills, a manual pin). A ref that is left out keeps its image from `current.env`; an explicit run skips the revision-label wait and the `failed.env` refusal. A ref needs a registry host, for example `ghcr.io/mwijkhuisen/mjk-server:sha-<git>`.

## 4. The gap during a deploy (measured)

Caddy's `lb_try_duration` is 5 s, so a restart of `api` or `ssr` behind a running caddy is a pause, not a 502. But every release builds a new web image (its revision label alone changes the digest), so a deploy also recreates caddy, and while it is replaced the published port is gone. Measured on the VM (2026-11-26) with the loop below across two deploys (a pin back to the previous release, then `:main` again; all three images new each time): per deploy one `502`, then ten `000` (refused connections), then `200` again, roughly 5 to 10 s without a site. Through the tunnel a visitor sees Cloudflare's error page for that time. Accepted for prelaunch; decided before P5a (A§17.2). Measure again with timestamps at a later deploy, from a second terminal on the VM:

```bash
while :; do printf '%s %s\n' "$(date +%T.%N | cut -c1-12)" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: <domain>" http://127.0.0.1:8280/musea)"; sleep 0.5; done
```

Run it across a deploy (`systemctl start mjk-update.service`) and write the first and last non-`200` times into A§17.2. A pause (slow answers) is fine.

## 5. After a failed deploy

1. Read `journalctl -u mjk-update.service -n 120` for the reason code. `migrate_failed`: `mjkc --profile jobs run --rm -T migrate` shows the dbmate message. `not_healthy`: `mjkc logs --tail 50 <service>` (logs hold fixed codes only).
2. Fix forward: push the fix to `main`, approve the release. The new set differs from `failed.env`, so the next run tries it.
3. If you want the same set again (for example a transient failure): `rm /srv/mjk/state/failed.env`.

## 6. Pausing automatic updates

```bash
systemctl disable --now mjk-update.timer      # stop automatic updates; mjk-tick and the backup keep running
systemctl enable --now mjk-update.timer
```

Do not stop `mjk-tick.timer`: it reloads a missing firewall table and restarts unhealthy containers (Docker restarts only exited ones).

## 7. What `mjk-install` is for, and what it is not

Compose, the Caddyfile (inside the web image), `mjk.nft`, the units and the scripts change rarely and are applied with `deploy/bin/mjk-install` from a checkout (`docs/runbooks/install.md` §11). `mjk-update` never runs a file of the checkout.

## 8. P2a deploy order (accounts)

P2a adds two secret files, `app_keys` (the api, worker and admin) and `lettermint_api_token` (the worker), and two settings that mail needs, `MJK_MAIL_FROM` and `MJK_MAIL_CAP`. The order matters:

1. **Before the merge**, create both files, `root:<gid> 0440` (`app_keys` 63012, `lettermint_api_token` 63008; `docs/runbooks/install.md` §4 has the format and the commands that keep the value out of the history). A placeholder token is fine until A4.
2. **After the merge, before you approve the `release` job**, run `deploy/bin/mjk-install` from the merged checkout (§7). It installs the new compose file and `mjk-envcheck` (which now allows `MJK_MAIL_FROM`). The old images keep running with the new mounts.
3. Add `MJK_MAIL_FROM` and `MJK_MAIL_CAP` (the plan's monthly cap: `300` on the free plan) to `/etc/mjk/mjk.env`. Without either, every mail job fails `mail_unconfigured` (no code reaches anyone) and the worker's health ping fails; its other jobs run. The install does not check them.
4. Approve `release`.

Why: the new `api` reads `app_keys` at start and exits 78 without it. Under the old compose file that is the case, because the file is not mounted, so the deploy fails `not_healthy`, `mjk-update` rolls back and writes `failed.env` (§5). Doing step 2 first mounts the files before the new images start.
