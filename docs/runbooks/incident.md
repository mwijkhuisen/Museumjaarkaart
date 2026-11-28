# Runbook: incidents

For the owner. Site down, a bad deploy, a full disk, the firewall, a leaked secret. Each section starts with what you see and the first command. The code wins where this text differs: `deploy/bin/mjk-update`, `deploy/bin/mjk-tick`, `deploy/host/`.

Everything runs as root on the VM. Shorthand:

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

Never touch the Waterheight (`rws`) or F1 (`f1`) stacks while fixing this one; `docker ps` without a project filter lists theirs too, so always filter by `label=com.docker.compose.project=mjk` or use `mjkc`. Logs hold fixed codes and ids only (invariant 8): reading them is safe, and pasting them into an issue is too, but never paste a secret file.

## 1. First look (any incident)

```bash
mjkc ps                                                    # state and health of the seven daemons (`media` is one)
systemctl list-timers 'mjk-*' --no-pager                   # are the three timers on?
journalctl -u mjk-update.service -u mjk-tick.service -u mjk-backup.service --since '-6 hours' --no-pager | tail -60
cat /srv/mjk/state/current.env /srv/mjk/state/guard/disk 2>/dev/null; ls /srv/mjk/state
nft list table inet mjk >/dev/null && echo 'firewall table loaded' || echo 'FIREWALL TABLE MISSING (section 5)'
curl -sS -o /dev/null -w 'caddy %{http_code}\n' -H 'Host: <domain>' http://127.0.0.1:8280/api/v1/healthz
```

## 2. The site is down

What you see: Cloudflare error 5xx (502 Bad Gateway, 521 web server is down, 522, 530), or a blank page. Find the first broken link, from the outside in:

| Check | Meaning |
|---|---|
| `curl -sI https://<domain>/` is 52x/530, but the line above (`caddy 200`) is fine | the tunnel: `mjkc ps cloudflared`, `mjkc logs --tail 30 cloudflared`. A restart: `mjkc restart cloudflared`. A bad token: `docs/runbooks/secrets-rotation.md` §2. A stale `cf_tunnel4` blocks it: section 5 |
| `caddy` is not 200 | `mjkc ps caddy`; `mjkc logs --tail 30 caddy` (Caddy's access log is off by design, its error log carries no client address); `mjkc restart caddy` |
| 502 from caddy | the upstream: `mjkc ps api ssr`; `mjkc logs --tail 30 api` / `ssr`; `mjkc restart ssr` or `api` |
| `api` or `ssr` unhealthy | the database: `mjkc ps db`, `mjkc logs --tail 30 db`, then section 7 |
| everything stopped, `/srv/mjk/state/firewall-stopped` exists | the fail-closed stop: section 5 |

Docker never restarts an unhealthy container (only an exited one); `mjk-tick` does every 10 minutes at :07. To act now: `systemctl start mjk-tick.service`.

## 3. A bad deploy

`mjk-update` rolls back by itself and writes `failed.env` (`docs/runbooks/update.md`). If the new release is bad in a way the smoke test did not catch:

```bash
cat /srv/mjk/state/current.env                       # the digests now running
# the previous release: the :sha-<git> tag of the last good commit
mjk-update --server ghcr.io/mwijkhuisen/mjk-server:sha-<good git> --web ghcr.io/mwijkhuisen/mjk-web:sha-<good git> --backup ghcr.io/mwijkhuisen/mjk-backup:sha-<good git>
systemctl stop mjk-update.timer                      # stop it taking :main again while you fix forward
```

A rollback never runs a migration down; a migration must work with the previous image. When the fix is on `main` and released, `systemctl start mjk-update.timer`.

## 4. The disk is full or nearly

`/srv/mjk/state/guard/disk` (written every 10 minutes; an older install's `/srv/mjk/state/disk` is stale and may be removed) holds `free_pct`, `free_bytes`, `total_bytes`, `checked`. Below 10 % free [U] the `api` refuses new uploads (from P3b) and the status panel turns red (P3c). A file older than 30 minutes counts as "full" for that guard, so also check that `mjk-tick.timer` runs.

```bash
df -h /srv /var/lib/docker
du -xsh /srv/mjk/* /var/lib/docker/containers 2>/dev/null | sort -h | tail
journalctl --disk-usage
```

The disk is shared with Waterheight and F1: every step below touches only mjk's own images, containers and directories, never theirs. Never run a host-wide `docker image prune`, `docker system prune` or `docker container prune`: they delete rws and f1 images (a rollback image pulled by digest counts as dangling) and containers too.

What may go, in this order:

```bash
# 1. Old mjk images. mjk-update already removes them after each deploy; by hand, only references of
#    ghcr.io/mwijkhuisen/mjk-* that current.env does not name (docker refuses an image that is in use).
cat /srv/mjk/state/current.env
docker image ls --digests --filter 'reference=ghcr.io/mwijkhuisen/mjk-*'
docker rmi ghcr.io/mwijkhuisen/mjk-server@sha256:<an old digest>      # one by one, never a current one
# 2. Stopped one-off mjk containers (a killed backup or sync), by the compose project label only.
docker ps -a -q --filter label=com.docker.compose.project=mjk --filter status=exited --filter label=com.docker.compose.oneoff=True | xargs -r docker rm
# 3. Our own directories.
ls -la /srv/mjk/exports /srv/mjk/tiles-build /srv/mjk/backup-staging
rm -f /srv/mjk/backup-staging/mjk.dump                                 # a stale dump after a failed backup
```

`/srv/mjk/exports` (bundles are deleted after 7 days by the worker); `/srv/mjk/tiles-build` (emptied after the upload, P1d). The Docker `local` log driver keeps rotated logs per container, within the per-container limits of the compose file (`docker system df -v` shows them). Never delete `/srv/mjk/originals` (the only copy besides the backup), `/srv/mjk/state` or the `mjk_pgdata` volume.

**Not a step: the systemd journal.** `journalctl --vacuum-size=…` deletes the journal of the whole host, Waterheight's and F1's history included. That affects rws and f1 too, so it is the owner's call as the host's administrator, outside this runbook.

## 5. The firewall

The table `inet mjk` is the egress policy of the stack; without it the stack's egress would be open (`table inet rws` and `table inet f1` match only their own bridges).

- **The table is missing** (for example Debian's `nftables.service` stopped and emptied everything): `mjk-tick` loads it again from `/etc/mjk/mjk.nft` within 10 minutes, and refills `resolvers4`. To do it now: `systemctl restart mjk-firewall.service; systemctl start mjk-tick.service`. `mjk-update` refuses to deploy (`firewall_missing`, exit 1) until the table is back.
- **It cannot be loaded** (a bad `/etc/mjk/mjk.nft`): `mjk-tick` fails closed: it stops every `mjk` container and writes `/srv/mjk/state/firewall-stopped`. The site is down on purpose. Fix `mjk.nft` (a PR, then `deploy/bin/mjk-install`, or `nft -c -f /etc/mjk/mjk.nft` to see the error), then `systemctl start mjk-tick.service`: it starts `current.env` again and removes the marker. Never run a command that empties the whole ruleset: it would delete Docker's tables and those of Waterheight and F1.
- **DNS fails in the egress containers** (the worker cannot resolve Wikidata): `resolvers4` is empty or stale. `mjk-resolvers && nft list set inet mjk resolvers4`. After a change of the host's resolvers: `systemctl start mjk-tick.service`.
- **The worker resolves a host but cannot connect to it** (a sync, a mail, the ping or a tiles refresh times out, from P3b): the host's address is not in `worker_dst4`, or the host is missing from `/etc/mjk/egress-hosts`. `mjk-egress; echo $?` (0 replaced · 75 some host had no address, the line numbers are named · 1 nothing changed) and `nft list set inet mjk worker_dst4`. A host the code dials that the list lacks is a PR to `deploy/host/egress-hosts` (`test/egress-hosts.test.ts` holds the two equal), then `deploy/bin/mjk-install`. R2 and other Cloudflare-fronted hosts go through `cf4` instead (`docs/runbooks/cloudflare.md`).
- **A Cloudflare range changed** and the backup, the Access certs (admin 503) or the tunnel time out while the table is loaded: `cf4` or `cf_tunnel4` is stale. Compare with the live lists (`docs/runbooks/cloudflare.md` §6), fix `deploy/host/nftables/mjk.nft` through a PR and run `deploy/bin/mjk-install`.
- To see what the table drops: `nft list table inet mjk | grep -B1 counter` (the counters count packets; only the "everything else" and "private" lines mean a blocked attempt).

## 6. A secret leaked, or something unexpected was released

1. **A secret in a log, a screenshot or a shared place:** rotate it now (`docs/runbooks/secrets-rotation.md`), then find how it got there. Secrets are never in the logs by design, so a leak there is itself a bug: keep the lines, remove the secret from them, and open an issue.
2. **A GHCR image you did not publish** (the package page lists a version you did not release), or the `release` job ran without your approval: treat the VM as exposed. `systemctl stop mjk-update.timer`; deploy the last good images by digest (section 3); rotate `GHCR_PUSH_TOKEN` and the GHCR packages' settings (`docs/runbooks/cloudflare.md` §8); check `current.env` against the digests you released; read the diff of the workflow files in the last merged PRs. Rotate the database logins and the tunnel token if the rogue image ran.
3. **Personal data in danger** (a database or a backup exposed): this is a breach under the GDPR; the AP must be told within 72 hours. The breach runbook and the Art. 30 register arrive with P3d (`docs/runbooks/breach.md`); until then, write down the time you learned of it, what was exposed and what you did, and contact the AP's data-breach notification desk.

## 7. The database

- **`db` unhealthy or restarting:** `mjkc logs --tail 40 db` (error lines carry constraint names, never values). Out of disk: section 4. Out of memory: `docker inspect -f '{{.State.OOMKilled}}' mjk-db-1`; the limit is 1 GB (A§17.2) [U box]. After a crash PostgreSQL recovers by itself on restart: `mjkc restart db`, and give it a minute.
- **A migration that went wrong:** `mjk-update` already rolled the images back; the schema stays (expand-only). Fix forward with a new migration; never edit an applied one.
- **The data is lost or corrupt:** restore from the nightly backup: `docs/runbooks/backup.md` for the repository, `docs/runbooks/restore-drill.md` for the mechanics, and `docs/runbooks/install.md` to rebuild the host side. Put the site into maintenance until the deletions since the snapshot are re-applied (A§17.6). RPO is 24 hours.

## 8. The backup or its ping failed

The check `mjk-backup` on healthchecks.io turns red after its period plus 2 hours of grace, or immediately on `/fail`. `journalctl -u mjk-backup.service -n 80 --no-pager`: the role's fixed code says which (69 database or repository unavailable, 70 failed, 78 config). `docs/runbooks/backup.md` §3 lists the causes. A failed run leaves no dump behind (it is deleted in a `finally`); `ls -A /srv/mjk/backup-staging` should be empty. The next timer run retries; to retry now: `systemctl start mjk-backup.service`.

## 9. The admin host answers 401 or 503

`admin.<domain>` is checked twice (Cloudflare Access, then the api). A 401 with the log code `access_refused` is the api refusing a JWT (a wrong `CF_ACCESS_AUD` or `CF_ACCESS_TEAM`, an expired token, an unknown key: `docs/runbooks/cloudflare.md` §3). A 503 means the api could not refresh Cloudflare's certs for more than an hour (stale window used up): `mjkc logs --tail 30 api`, then the firewall (section 5: `cf4`) and `curl -sI https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` from the VM.

## 10. After any incident

Write down, in an issue: when it began and ended, the first symptom, the cause, what you changed, and whether a runbook or a limit (A§17.2) should change. A change to compose, the firewall, Caddy or a unit goes through a PR and the owner's line-by-line read of `deploy/` (A§16.3).
