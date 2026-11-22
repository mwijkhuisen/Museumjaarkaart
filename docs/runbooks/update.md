# Runbook: update and rollback

For the owner. How new images reach the VM, how a bad one is rolled back, and how you prove it (P1e criterion 8). The code wins where this text differs: `deploy/bin/mjk-update` and `deploy/bin/mjk-tick`.

All commands run as root on the VM. Shorthand (as in `docs/runbooks/install.md` §6):

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

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
- State, all in `/srv/mjk/state`: `current.env` (the three refs of the last good deploy and `MJK_COMPOSE_SHA256`), `failed.env` (the same for the last failed one), `disk` (written by `mjk-tick`), `firewall-stopped` (see `docs/runbooks/incident.md`).
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

## 4. A deploy without a 502 [U box]

Caddy's `lb_try_duration` is 5 s, so a restart during a deploy should be a pause, not a 502; that is configured and asserted, but only a real deploy proves it. During the next release, from a second terminal on the VM:

```bash
while :; do curl -s -o /dev/null -w '%{http_code} ' -H "Host: <domain>" http://127.0.0.1:8280/musea; sleep 0.5; done
```

Run it across a deploy (`systemctl start mjk-update.service`). Write the result into A§17.2: any `502` or `000` in the run, and for how long. A pause (slow answers) is fine.

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
