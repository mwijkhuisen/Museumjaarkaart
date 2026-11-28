# Runbook: install on the VM

For the owner. It takes the shared Debian 13 VM from nothing to the stack `mjk` running behind the Cloudflare tunnel, prelaunch and noindex (P1e). Everything here is a [box] or [owner] step of P1e. The code wins where this text differs: report the difference.

Rules that hold throughout (CLAUDE.md invariants 1 and 2):
- Never touch `/etc/rws`, `/srv/rws`, `/etc/f1`, `/srv/f1`, their compose projects (`rws`, `f1`), tables, GIDs or timers. `mjk-install` refuses on any collision, and you only ever read the two project listings.
- No secret goes on a command line, into `mjk.env`, into the shell history or into git. Secrets are files (§4).
- Work in a root shell (`sudo -i`) on the VM. A secret never leaves it except through your password manager.

## 1. What you need first

| What | Owner action | Where it is described |
|---|---|---|
| The domain `<domain>` and the brand | A1 | `MJK_DOMAIN`, `MJK_BRAND_NAME` in `mjk.env` |
| The Cloudflare zone, the tunnel and its token, the Access application, the R2 buckets and keys | A2 | `docs/runbooks/cloudflare.md`, `docs/runbooks/backup.md` |
| The VM resize (8 vCPU / 16 GB proposed) | A3 | A§17.1; the `docker stats` day in §9 confirms or revises it |
| The healthchecks.io account for mjk and its ping key | A8 | `docs/runbooks/backup.md` §7 |
| The GHCR packages public, and the `release` job pushed by you | A§16.3 | `docs/runbooks/cloudflare.md` §8 (the workflow diff and the Q7 record) |

On the VM: Docker 29 with Compose 5, `nft`, `curl`, `jq`, `flock` (util-linux), `git`, `systemd`. `docker info` must answer.

## 2. Get the checkout

`mjk-install` is run from a checkout of the repository. It copies files into `/etc/mjk`, `/usr/local/bin` and `/etc/systemd/system`; the timers then run those copies, never a file of the checkout.

```bash
cd /root && git clone https://github.com/mwijkhuisen/mjk.git mjk-checkout
cd mjk-checkout                                      # on `main`: P1e and P1d are merged
```

## 3. Before: list the other stacks (criterion 6)

The VM also runs a third stack, `notes` (compose project `notes`, `/etc/notes`, `table inet notes`; found on 2026-11-26), and invariant 2 covers it like `rws` and `f1`. `docker compose ls` lists every project.

```bash
docker compose -p rws ps > /root/rws-before.txt
docker compose -p f1 ps > /root/f1-before.txt
docker compose -p notes ps > /root/notes-before.txt
docker network ls --format '{{.Name}} {{.Driver}}' | sort > /root/networks-before.txt
nft list tables > /root/nft-tables-before.txt
```

## 4. The first install, then the secrets

```bash
cd /root/mjk-checkout && deploy/bin/mjk-install
```

The first run:
- refuses (exit 1, `REFUSED: …`, nothing changed) when a group name or GID collides with `rws` or `f1`, a path resolves into their trees, an `mjk-*` Docker network belongs to another compose project, or one of the eight subnets (10.63.1.0/24 … 10.63.8.0/24) overlaps another Docker network or a host route;
- creates the groups `mjk_<secret>` (GIDs 63001 to 63013), `/etc/mjk` (0755), `/etc/mjk/secrets` (0700 root), `/etc/mjk/postgres`, `/srv/mjk/state` (root 0755), `/srv/mjk/state/guard` (root 0755; P3b: `mjk-tick` writes the disk file there and the `api` mounts it read-only) and `/srv/mjk/{originals,quarantine,exports,tiles-build,backup-staging}` (63532:63532 0700). The `media` container's one mount, `media-work`, is not a host directory but the tmpfs volume `mjk_media_work` (256 MB), which Compose makes at the first start (A§17.1);
- copies the compose file, `roles.sql`, `mjk.nft`, the worker's hosts list `/etc/mjk/egress-hosts` (P3b), the units and `mjk-update`, `mjk-tick`, `mjk-resolvers`, `mjk-egress`, `mjk-ping`; a changed `mjk.nft` reloads the firewall unit, a changed hosts list alone runs `mjk-egress` (it refills `worker_dst4`, A§17.4);
- enables and starts `mjk-firewall.service` (loads `table inet mjk`; `nft -c` first), then starts `mjk-egress.service` (P3b review: fills `worker_dst4`; wanted by the firewall unit and ordered after it, never before Docker, so its lookups do not hold up any stack at boot);
- prints `NOT ENABLED: …` and the names of everything still missing, and leaves the three timers off.

### The secrets

Each secret is one file in `/etc/mjk/secrets`, owned `root:<gid>`, mode `0440`, not empty. The compose file mounts only the secrets a container needs, with its GID added by `group_add`. Names, GIDs, consumers and formats (A§17.3):

| File | Group (GID) | Consumers | What the file holds |
|---|---|---|---|
| `db_postgres` | `mjk_db_postgres` (63001) | db | 24 or more characters of `A-Za-z0-9_-` |
| `db_mjk_migrator` | `mjk_db_mjk_migrator` (63002) | db, migrate | the same format |
| `db_mjk_api` | `mjk_db_mjk_api` (63003) | db, api, admin | the same format |
| `db_mjk_ssr` | `mjk_db_mjk_ssr` (63004) | db, ssr | the same format |
| `db_mjk_worker` | `mjk_db_mjk_worker` (63005) | db, worker, sync-museums | the same format |
| `db_mjk_backup` | `mjk_db_mjk_backup` (63006) | db, backup | the same format |
| `cf_tunnel_token` | `mjk_cf_tunnel_token` (63007) | cloudflared | the tunnel token from the Cloudflare dashboard (one line) |
| `r2_backup_put` | `mjk_r2_backup_put` (63010) | backup | an AWS credentials file for the Object Read & Write token on `mjk-backup` only: `[default]`, then `aws_access_key_id = …` and `aws_secret_access_key = …` |
| `restic_password` | `mjk_restic_password` (63011) | backup | a long random password (one line) |
| `r2_media_rw` | `mjk_r2_media_rw` (63009) | worker (the quarterly tiles job, P1d) | an AWS credentials file for the Object Read & Write token on `mjk-media` only, the format of `r2_backup_put` |
| `hc_ping_key` | `mjk_hc_ping_key` (63013) | worker, and the host unit `mjk-backup.service` as root | the healthchecks.io project's ping key: 16 to 64 characters of `A-Za-z0-9_-` |
| `app_keys` | `mjk_app_keys` (63012) | api, worker, admin (P2a) | four lines `otp_pepper=…`, `invite_pepper=…`, `code_seal=…`, `altcha_hmac=…`, each value the base64url (no padding, 43 characters) of 32 random bytes; the api, worker and admin exit 78 on any other shape |
| `lettermint_api_token` | `mjk_lettermint_api_token` (63008) | worker only (P2a) | the Lettermint API token (one line); until owner action A4 is done a placeholder line is acceptable, and every mail then fails with a fixed code |

`app_keys` and `lettermint_api_token` arrive with P2a (the order of that deploy is in `docs/runbooks/update.md` §8); `mjk-install` lists them as missing and `mjk-update` refuses a compose file without them until they exist. `r2_media_rw` needs the media bucket and its token (`docs/runbooks/tiles-refresh.md` §2): Compose will not start the `worker` without the file. On a first install `mjk-install` lists it as missing and leaves the timers off until it exists. **On a host that already runs P1e** the timers are on: create `r2_media_rw` and set `MJK_R2_BUCKET_MEDIA` in `mjk.env` first, before the `mjk-install` that brings P1d (§11); `mjk-update` refuses a compose file whose secret files are missing (`config_missing: secret file(s) missing: …`, exit 78, the running stack untouched) until they exist. The database passwords are read by `roles.sql` on the first start of the `db` volume only (§5), so they must exist before the first deploy. A database password with any other character fails with `roles.sql: cannot set up login …`.

How to create them without a secret entering the shell history, a process list or a log (run in the root shell; `read -rs` and `printf` are shell builtins, so the value is never an argument of a program; `HISTFILE=` keeps this shell's history off the disk):

```bash
HISTFILE=; umask 077; cd /etc/mjk/secrets

# A generated password (db_* and restic_password): the value goes from openssl into the file, never through an argument.
for name in db_postgres db_mjk_migrator db_mjk_api db_mjk_ssr db_mjk_worker db_mjk_backup restic_password; do
  [ -e "$name" ] || openssl rand -hex 32 > "$name"
done

# A value you paste (cf_tunnel_token, hc_ping_key): typed or pasted into a silent prompt.
read -rs -p 'tunnel token: ' v; echo; printf '%s' "$v" > cf_tunnel_token; unset v
read -rs -p 'healthchecks ping key: ' v; echo; printf '%s' "$v" > hc_ping_key; unset v

# The R2 key files: two silent prompts each, written as the AWS credentials format restic reads.
read -rs -p 'R2 access key id (mjk-backup): ' id; echo
read -rs -p 'R2 secret access key: ' key; echo
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$key" > r2_backup_put; unset id key
read -rs -p 'R2 access key id (mjk-media): ' id; echo
read -rs -p 'R2 secret access key: ' key; echo
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$key" > r2_media_rw; unset id key

# app_keys (P2a): four generated values, each from openssl straight into the file (base64url, no padding).
if [ ! -e app_keys ]; then
  for k in otp_pepper invite_pepper code_seal altcha_hmac; do
    printf '%s=%s\n' "$k" "$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
  done > app_keys
fi

# lettermint_api_token (P2a): pasted into a silent prompt (a placeholder until A4 is done).
read -rs -p 'Lettermint API token: ' v; echo; printf '%s' "$v" > lettermint_api_token; unset v
```

Then the exact owner and mode of each, and a check by name (this prints names and modes only, never a value):

```bash
cd /etc/mjk/secrets
for pair in db_postgres:63001 db_mjk_migrator:63002 db_mjk_api:63003 db_mjk_ssr:63004 db_mjk_worker:63005 \
  db_mjk_backup:63006 cf_tunnel_token:63007 r2_media_rw:63009 r2_backup_put:63010 restic_password:63011 hc_ping_key:63013 \
  app_keys:63012 lettermint_api_token:63008; do
  chown "root:${pair##*:}" "${pair%%:*}" && chmod 0440 "${pair%%:*}"
done
stat -c '%U:%g %a %n' /etc/mjk/secrets/*
```

Expected: every line `root:<gid> 440`. Put each value (not the file) into your password manager as you create it; the restic password and the R2 keys are the only way to restore (A§17.6).

### mjk.env

`/etc/mjk/mjk.env` is config, not secrets (`root:root`, mode 0644 or 0640, one `KEY=value` per line, no quotes, no spaces). Compose gives every key to every Node container as `env_file`, so `mjk-install` refuses the file when its owner or mode is anything else, or when it holds a key outside this allowlist: the keys below, plus `MJK_MAIL_FROM` (the sender address of the sign-in mails) and `MJK_MAIL_CAP` (P2a: the monthly cap, `300` on the free plan; mail needs both, and without either every mail job fails `mail_unconfigured` and the worker's health ping fails) and `MJK_SIGNUP` (a later phase) and the optional `MJK_R2_REGION`. So no `DATABASE_URL` (it would replace every login's file secret), no `NODE_OPTIONS`, no `*_FILE` path and no password ever goes in it. The refusal names the key or the line number, never a value. The check is `/usr/local/bin/mjk-envcheck`, and `mjk-update` runs it again before every deploy, so an edit after the install is refused there too (exit 78).

```bash
cat > /etc/mjk/mjk.env <<'EOF'
MJK_BRAND_NAME=Muzelog
MJK_DOMAIN=muzelog.nl
MJK_PROFILE=prelaunch
MJK_SYNC_CONTACT=<an email address or an https URL for Wikimedia's user agent>
CF_ACCESS_TEAM=<the team name: the label before .cloudflareaccess.com>
CF_ACCESS_AUD=<the Access application's AUD tag: 64 lowercase hex characters>
MJK_CONTROLLER_NAME=<your name as the controller of /privacy>
MJK_CONTACT_EMAIL=<the contact address of /privacy and /contact>
MJK_R2_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com
MJK_R2_BUCKET_BACKUP=mjk-backup
MJK_R2_BUCKET_MEDIA=mjk-media
EOF
chmod 0644 /etc/mjk/mjk.env
```

- `MJK_PROFILE` is `prelaunch` in P1e; any other value, or none, makes Caddy fail to start (only `profile-prelaunch.caddy` ships).
- A missing or malformed value makes the role log the variable's name and exit 78 (`MJK_CONTROLLER_NAME` 1 to 100 characters; `CF_ACCESS_AUD` exactly 64 hex characters; `CF_ACCESS_TEAM` one label of lowercase letters, digits and hyphens).
- The endpoint must be the `.eu.` form for the EU jurisdiction bucket; the jurisdiction cannot change later (`docs/runbooks/backup.md` §1).
- `MJK_R2_BUCKET_MEDIA` is the bucket of the worker's tiles job (P1d, `docs/runbooks/tiles-refresh.md`); P3b's photo variants use it too.

## 5. Second install: timers, and the idempotence proof

```bash
cd /root/mjk-checkout && deploy/bin/mjk-install
```

With every secret and every `mjk.env` key in place, the output ends with `secrets and mjk.env are in place; the three timers are enabled` and `mjk-update.timer`, `mjk-tick.timer` and `mjk-backup.timer` are on. If a line `NOT ENABLED` remains, it names what is wrong (a missing file, a wrong owner or mode, an empty file, a key not set); fix it and run again. A `REFUSED` line about `mjk.env` (its mode, a key that is not allowed) stops the installer before it changes anything.

Run it a third time: it must print `no changes: everything was in place` (a file is rewritten only when its content, owner or mode differs). That is criterion 6 (idempotent).

```bash
deploy/bin/mjk-install | tee /root/install-third-run.txt     # expect: mjk-install: no changes: everything was in place
systemctl list-timers 'mjk-*' --no-pager
nft list table inet mjk | head -3
```

## 6. The first deploy

The Cloudflare tunnel must exist first (`docs/runbooks/cloudflare.md` §2): `cloudflared` has to become healthy, and `mjk-update` waits for every daemon (180 s) and rolls back otherwise.

The `release` job (after you have pushed the workflow diff and approved the `production` environment) puts `mjk-server`, `mjk-web` and `mjk-backup` on GHCR as `:main` and `:sha-<git>`. The three packages must be public (anonymous pull). Then:

```bash
systemctl start mjk-update.service        # or wait up to 10 minutes for mjk-update.timer
journalctl -u mjk-update.service -n 60 --no-pager
```

Before the first release exists, or for a drill, deploy given images (a ref with a registry host is recorded by digest):

```bash
mjk-update --server ghcr.io/mwijkhuisen/mjk-server:sha-<git> --web ghcr.io/mwijkhuisen/mjk-web:sha-<git> --backup ghcr.io/mwijkhuisen/mjk-backup:sha-<git>
```

What it does is in `docs/runbooks/update.md` §1. On the very first run the `db` volume is created and `roles.sql` sets the five logins' passwords from the secret files (it runs from `/docker-entrypoint-initdb.d/` only when the volume is new). If a database secret was wrong on that first deploy, the volume holds a half-initialised cluster on which `roles.sql` never runs again, and `mjkc` (below) does not work yet: a failed first deploy writes no `current.env`, and `mjk-update` has already stopped the stack. While the database is still empty (before the seed), fix the secret file, then:

```bash
docker volume rm mjk_pgdata               # the stack is already down; this is the only copy, so only before the seed
rm -f /srv/mjk/state/failed.env
systemctl start mjk-update.service        # or the same mjk-update --server … --web … --backup … again
```

Define the shorthand used in every runbook:

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
mjkc ps
cat /srv/mjk/state/current.env          # the three refs by digest and MJK_COMPOSE_SHA256
```

Expected: `db`, `api`, `ssr`, `worker`, `caddy` and `cloudflared` healthy; `current.env` holds `MJK_SERVER_IMAGE`, `MJK_WEB_IMAGE` and `MJK_BACKUP_IMAGE`.

Then seed the catalogue (once; `docs/runbooks/museum-sync.md` §3 and §12):

```bash
mjkc --profile tools run --rm sync-museums --seed --dry-run
mjkc --profile tools run --rm sync-museums --seed
```

## 7. Smoke test, noindex and the host-side behaviour (criteria 3, 4, 11)

From the VM, through the published port (the only one, `127.0.0.1:8280`), with the public `Host`:

```bash
D=<domain>
curl -sS -H "Host: $D" http://127.0.0.1:8280/api/v1/healthz ; echo
curl -sI -H "Host: $D" http://127.0.0.1:8280/musea | head -20
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $D" -H 'X-Forwarded-Proto: http' http://127.0.0.1:8280/        # expect 308
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: not-ours.example' http://127.0.0.1:8280/                       # expect 421
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $D" http://127.0.0.1:8280/api/admin/anything                   # expect 404 (the public host has no admin)
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: admin.$D" http://127.0.0.1:8280/api/admin/anything             # expect 401 (no Access JWT)
ss -ltnp | grep -E ':8280|:8089'                                                                                  # 8280 on 127.0.0.1 only; 8089 is inside the caddy container
```

Every response carries `X-Robots-Tag: noindex` (criterion 11). Through the real hostname, a page, an asset, the health route and a 404:

```bash
ASSET=$(curl -s https://$D/ | grep -o '/assets/[^"]*' | head -1)
for path in / "$ASSET" /api/v1/healthz /does-not-exist; do
  printf '%s  ' "$path"; curl -sI "https://$D$path" | grep -i -E '^(HTTP|x-robots-tag)' | tr -d '\r' | paste -sd' '
done
```

Expected: each line shows `noindex` (the 404 and the 421 included: Caddy's error path repeats the headers).

## 8. Egress probes (criterion 7)

The images have no shell, so a probe is a throw-away busybox container that shares the service's network namespace, which gives it the service's address and so the firewall's treatment of that service. The pinned image is the one `deploy/tests/e2e.sh` uses. A probe is judged by the drop counters of `table inet mjk`, so a connection that is accepted but gets no answer still counts correctly.

```bash
BB=busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
drops() { nft list table inet mjk | grep -E 'counter packets' | sed -E 's/^[[:space:]]+//' ; }
probe() { # <container> <command...>
  local c=$1; shift
  echo "--- $c: $*"; drops > /tmp/d0
  docker run --rm --network "container:$c" --user 63532:63532 --read-only --cap-drop ALL --security-opt no-new-privileges "$BB" "$@"; echo "exit $?"
  drops > /tmp/d1; diff /tmp/d0 /tmp/d1 | grep '^>' || echo "(no drop counter moved)"
}
```

The probes and what each must show:

```bash
# worker (from P3b, A§17.4): tcp/443 only to cf4 and worker_dst4; port 80 and private ranges never.
probe mjk-worker-1 nc -w 3 -z 9.9.9.9 443              # dropped (outside cf4 and worker_dst4): "everything else" counter moved
probe mjk-worker-1 nc -w 3 -z "$(nft list set inet mjk worker_dst4 | grep -oE '([0-9]+\.){3}[0-9]+' | head -1)" 443   # allowed: exit 0, no counter moved
probe mjk-worker-1 nc -w 3 -z 104.16.0.1 443           # allowed (inside cf4, R2's ranges): no counter moved
probe mjk-worker-1 nc -w 3 -z 9.9.9.9 80               # dropped: "everything else" counter moved
probe mjk-worker-1 nc -w 3 -z 192.168.0.1 443          # dropped: "private, link-local and CGNAT ranges" counter moved
# ssr reaches nothing (no external network at all).
probe mjk-ssr-1 nc -w 3 -z 9.9.9.9 443                 # fails, exit not 0
# api: only tcp/443 on Cloudflare's ranges.
probe mjk-api-1 nc -w 3 -z 104.16.0.1 443              # allowed (inside cf4): no counter moved
probe mjk-api-1 nc -w 3 -z 9.9.9.9 443                 # dropped: "everything else" counter moved
# backup: the same rule; the container exists only while a backup runs, so start it with a sleep.
mjkc --profile backup run -d --rm --name mjk-probe-backup --entrypoint /usr/local/bin/node backup -e 'setTimeout(()=>{},120000)'
probe mjk-probe-backup nc -w 3 -z 104.16.0.1 443       # allowed
probe mjk-probe-backup nc -w 3 -z 9.9.9.9 443          # dropped
docker rm -f mjk-probe-backup
# caddy's publish network has no egress at all; the tunnel network reaches only 7844 on cf_tunnel4.
probe mjk-caddy-1 nc -w 3 -z 9.9.9.9 443               # fails: caddy has no external route that the table allows
```

If a container name differs (`docker ps --format '{{.Names}}'` lists them), use that name. Paste the output of all probes into the PR. If `104.16.0.1` is refused by Cloudflare with no drop counter moved, the rule still passed: the counters are the proof. `cf4` was written from the agent's knowledge, not fetched; compare it with the live list now (`docs/runbooks/cloudflare.md` §6).

**DNS from the containers (P1e review S13, A§17.4; proven on the VM, 2026-11-26).** Docker's embedded DNS (`127.0.0.11` in each container) asks the host's resolvers from the host's own namespace, past `resolvers4` and the DNS rule, whatever resolver the host uses (A§16.2). `caddy` has `dns: 127.0.0.1` for that reason, and `ssr` is internal-only, so both must get SERVFAIL for an outside name; `api`, `worker`, `sync-museums` and `backup` resolve it, and no counter moves for any of them. Check it again after a Docker upgrade or a change to the networks:

```bash
for c in mjk-ssr-1 mjk-caddy-1 mjk-api-1 mjk-worker-1; do probe "$c" nslookup example.org 127.0.0.11; done   # ssr and caddy: SERVFAIL
probe mjk-caddy-1 nslookup api 127.0.0.11                                                                     # caddy still finds api
mjkc --profile backup run -d --rm --name mjk-probe-backup --entrypoint /usr/local/bin/node backup -e 'setTimeout(()=>{},120000)'
probe mjk-probe-backup nslookup example.org 127.0.0.11; docker rm -f mjk-probe-backup
```

If `caddy` or `ssr` resolves an outside name, the channel is open again: stop and fix it through a PR (A§16.2).

**cloudflared's log (P1e review S14, invariant 8, A§17.7; proven on the VM, 2026-11-26).** `--loglevel error` drops the info and warning lines, but cloudflared's origin errors are error lines and might carry the request URL (`dest=`), query string included. On the VM the marker below came back 502 and appeared 0 times in the log (a refused origin). An origin that times out or resets takes other error paths and is not checked [U]. The case that matters is near-me's `?lat=`/`?lon=` query, a position to about 100 m. Check it again after a cloudflared upgrade, while nobody uses the site:

```bash
mjkc stop caddy
curl -s -o /dev/null "https://<domain>/musea?e2e-marker-$(date +%s)=1"
mjkc start caddy
mjkc logs --since 5m cloudflared | grep -c 'e2e-marker' || true       # 0 is the hoped-for answer
```

If the marker appears, record that in A§17.7 (the line, without the marker's value) and decide in a PR: accept it (the Docker log rotates, and only the owner reads it) or move cloudflared's log to `--logfile` on a tmpfs.

**`nftables.service` stays masked (P1e review S3; checked on the VM, 2026-11-26).** Debian's start and reload apply `/etc/nftables.conf`, which empties the whole ruleset: every table on the host, Docker's, Waterheight's, F1's and the `notes` stack's included. Never start or reload it on this shared host, not even to test `ReloadPropagatedFrom=nftables.service` in `mjk-firewall.service`. On the VM it is masked and inactive. Never run `systemctl stop nftables`, `restart`, `reload` or `mask --now` either: each runs its stop or reload, which empties the ruleset. If you ever find it active, mask it (without `--now`) and leave it running. Check it, read-only:

```bash
systemctl is-enabled nftables; systemctl is-active nftables     # masked, inactive
grep -n -E '^(flush|include|table)' /etc/nftables.conf | head -3
nft list tables
```

If it is ever enabled, mask it again (`systemctl mask nftables`). `mjk-tick` reloads `table inet mjk` within 10 minutes if anything empties it.

The host-input drop `containers never open a connection to the host` moves by a few packets now and then at rest (390 to 398 over an evening on 2026-11-26), not on a container start; the source is not identified yet (A§17.4). A probe judges only the counter that its own packets should move, so this does not matter to the probes. The source stays an open [U] that must be identified before invites go beyond the owner and test accounts: a real container-to-host attempt would move the same counter, and a one-minute log window cannot catch a few packets an evening.

## 9. A day of `docker stats` (criterion 11)

Sample the seven daemons once an hour for a day, in a tmux or screen session, then summarise the peak memory, CPU and PIDs of each service into A§17.2 and say whether A3 (the resize) holds:

```bash
for i in $(seq 24); do
  date -u +%FT%TZ >> /root/mjk-stats.txt
  docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' \
    $(docker ps -q --filter label=com.docker.compose.project=mjk) >> /root/mjk-stats.txt
  sleep 3600
done
```

Include a sync run and a backup run inside the day, and one `sync-museums` run (`docs/runbooks/museum-sync.md` §12): the limits must hold at the peak.

**Result (2026-11-26 18:25Z to 2026-11-27, 24 samples):** peaks `ssr` 141 MiB, `worker` 133, `api` 75, `db` 55, `caddy` 29, `cloudflared` 25 (about 0.46 GB together, each under 40 % of its limit); single-sample CPU at most 65 % of a core; PIDs at most 18. The VM afterwards: 6 vCPU, 7.9 GiB of 11.7 GiB available, load about 1.5. A3's resize is not needed for prelaunch (A§17.1, A§17.2). An hourly sample misses a job that runs a few minutes: this day probably missed the tiles extract (18:56 to 19:00:37Z) and caught neither the backup nor a sync, so their peaks are still open (watch `docker stats` during one, or read them at a monthly drill).

## 10. After: the other stacks still work (criteria 6 and 14)

```bash
docker compose -p rws ps > /root/rws-after.txt; diff /root/rws-before.txt /root/rws-after.txt && echo 'rws unchanged'
docker compose -p f1 ps > /root/f1-after.txt;   diff /root/f1-before.txt  /root/f1-after.txt  && echo 'f1 unchanged'
docker compose -p notes ps > /root/notes-after.txt; diff /root/notes-before.txt /root/notes-after.txt && echo 'notes unchanged'
docker network ls --format '{{.Name}} {{.Driver}}' | sort > /root/networks-after.txt
diff /root/networks-before.txt /root/networks-after.txt          # only the eight mjk-* networks are new
diff /root/nft-tables-before.txt <(nft list tables)              # only table inet mjk is added (a table its own stack reloaded moves to the end)
```

Container uptimes in `docker compose ps` can differ if a stack restarted for its own reasons; compare the project, service and image columns. Images can differ too when a stack deployed itself meanwhile: its own update journal shows it (on 2026-11-26 `f1-update` deployed new images at 18:30Z, and `rws-update` some hours earlier). Then open the Waterheight, F1 and `notes` sites in a browser (criterion 14, [owner]) and note in the PR that all three work, after the install and again after the first `mjk-update`.

## 11. Updating the host side later

**First, on a host that runs P1e and is about to get P1d:** create `/etc/mjk/secrets/r2_media_rw` (§4, `docs/runbooks/tiles-refresh.md` §2 items 1 to 3) and add `MJK_R2_BUCKET_MEDIA=mjk-media` to `mjk.env`, before the `git pull` and `mjk-install` below. Without the file `mjk-update` refuses every deploy with `config_missing: secret file(s) missing: /etc/mjk/secrets/r2_media_rw` and leaves the running stack as it is.

After a change to the compose file, the Caddyfile (it is in the web image), `mjk.nft`, a unit or a script: `git pull` in the checkout, then `deploy/bin/mjk-install`. It reloads the firewall only when `mjk.nft` changed and reloads systemd only when a unit changed. New images arrive through `mjk-update`, not through the installer (`docs/runbooks/update.md`). The installer only copies a changed compose file; the next `mjk-update` run sees its new sha256 and deploys the same images with it, with the health wait, the smoke test and the rollback. Start it at once and watch it:

```bash
systemctl start mjk-update.service
journalctl -u mjk-update.service -n 40 --no-pager   # "compose file changed since current.env", then "deployed: …"
```
