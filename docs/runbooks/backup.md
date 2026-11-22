# Runbook: backups

For the owner. How the nightly backup runs, how the locked R2 bucket, the keys and the healthchecks are set up, how you prove the lock (P1e criterion 10) and how retention runs from your workstation. Background: ADR-0011, A§17.6. The code wins where this text differs: `apps/server/src/backup/`, `deploy/host/systemd/mjk-backup.*` and `deploy/bin/mjk-ping`.

All commands marked "on the VM" run as root there. Shorthand:

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

## 0. What runs

- `mjk-backup.timer` fires every night at 01:43 Europe/Amsterdam (`Persistent=true`: a missed night runs after boot). It is clear of the Tuesday 03:17 museum sync and of the 10-minute timers.
- It starts `mjk-backup.service` (a oneshot on the host). The unit takes the deploy lock shared (waits up to an hour for a running `mjk-update`, which takes it exclusive and skips while the backup holds it; `mjk-tick` takes it shared too, so the firewall, restart and disk checks keep running during a long backup) and runs `docker compose … --profile backup run --rm -T backup`.
- The `backup` role (image `mjk-backup`, login `mjk_backup`, which can read everything and nothing else):
  1. `pg_dump --format=custom --lock-wait-timeout=60s` into `/srv/mjk/backup-staging/mjk.dump`, leaving out the data of `session`, `email_code`, `auth_challenge`, `rate_limit` and `job` (a restore signs everyone out; tables that do not exist yet are tolerated);
  2. `restic cat config` (the repository must exist), then `restic --no-cache backup --host mjk --tag nightly` of the dump and `/srv/mjk/originals` to `mjk-backup` on R2;
  3. deletes the dump and its 0600 password file, whatever happened. It never runs `init`, `forget` or `prune`: you create the repository once from the workstation (§3).
- Exit codes: 0 done · 69 the database or the repository is unavailable (restic retries for minutes first) · 70 failed, aborted or incomplete · 78 config (a missing secret file, a bad endpoint, a wrong restic password, or `repo_missing`: no repository at that endpoint and bucket, which a wrong bucket, a lost `config` or a run before §3 gives).
- The unit's `TimeoutStartSec=9h` is above the lock wait (1 h) plus the role's own bounds (pg_dump 1 h, the probe 5 min, restic 6 h). A run that systemd stops has its one-off container removed by `ExecStopPost` (by the compose labels), so it never runs on outside the lock. The log holds fixed codes and numbers only.
- After the run the unit's `ExecStopPost` runs `mjk-ping result`: `…/mjk-backup` after a success, `…/mjk-backup/fail` otherwise. The key is read from `/etc/mjk/secrets/hc_ping_key` as root and goes to `curl -K -` on stdin, so it is never in an argument list, the process table or the journal. The container never has the key.

## 1. The bucket and its lock rule (A2)

In the Cloudflare dashboard, R2 → Create bucket: name `mjk-backup`, location jurisdiction European Union, private (no custom domain, no public `r2.dev` URL). The jurisdiction cannot change later; the S3 endpoint is the `.eu.` form and goes in `MJK_R2_ENDPOINT` (`docs/runbooks/install.md` §4).

Bucket settings → Object lock rules: add one rule per prefix.
- `data/`, `index/` and `snapshots/`: retain for 28 days (age 2,419,200 s).
- `keys/` and `config`: retain **indefinitely** (no expiry). restic writes them once, at `init` (and `key add`), and never prunes them. With a 28-day age lock the VM's key could delete them from day 29, and without `config` and a key file every snapshot is undecryptable, the locked ones included (P1e security review S1).
- Do not add `locks/`: restic must be able to delete its own lock files [U box, §5].

R2 has no put-only permission and no object versioning [U box], so these rules are the only thing that stops the VM's key from deleting history.

**Offline copy of `config` and `keys/`.** Right after §3's `restic init`, and again after every `restic key add`, copy the repository's `config` and every object under `keys/` (a few hundred bytes each, already encrypted with the password) into your password manager, from the workstation:

```bash
restic cat config --json > /dev/null && echo 'repository reachable'
aws s3 cp --endpoint-url "https://<account id>.eu.r2.cloudflarestorage.com" s3://mjk-backup/config ./mjk-restic-config     # or rclone; workstation key
aws s3 cp --recursive --endpoint-url "https://<account id>.eu.r2.cloudflarestorage.com" s3://mjk-backup/keys/ ./mjk-restic-keys/
# attach both to the password manager entry of the restic password, then: rm -r ./mjk-restic-config ./mjk-restic-keys
```

With the password, these files are enough to read the data objects again even if `config` or `keys/` were ever lost.

Changing or removing a lock rule needs an Admin token. That token lives in your password manager only, never on the VM and never in a file there.

## 2. The keys

R2 → Manage API tokens, Object Read & Write, scoped to the one bucket `mjk-backup` each time:
- **The VM's key**: becomes `r2_backup_put` (an AWS credentials file, `docs/runbooks/install.md` §4). It can read, write and, outside the lock, delete in `mjk-backup`, and nothing in `mjk-media`.
- **The workstation key**: a second token with the same scope, kept off the VM. It runs `forget --prune` (§6) and the restore drill.
- **`restic_password`**: a long random password, generated on the VM into `/etc/mjk/secrets/restic_password` (`docs/runbooks/install.md` §4) and copied into your password manager at once. Losing it makes every backup unreadable.

## 3. The repository, then the first run (proves the endpoint and `cf4`)

The nightly job never creates a repository (a missing one is exit 78 `repo_missing`, and the ping fails). Create it once, from the workstation with §4's environment and the same password as `/etc/mjk/secrets/restic_password`:

```bash
restic snapshots 2>&1 | tail -1        # "Is there a repository at the following location?": none yet
restic init                            # once; it writes config and keys/<id>
restic cat config --json | head -c 80; echo
```

Then make the offline copy of `config` and `keys/` (§1). Then, on the VM:

```bash
systemctl start mjk-backup.service           # on the VM; waits for the lock, then runs
journalctl -u mjk-backup.service -n 60 --no-pager
systemctl status mjk-backup.service --no-pager | head -12
```

Expected: the unit ends `Succeeded`; the journal shows the role's fixed codes (`dump_done`, `backup_done` with the snapshot id), no command output with a secret; the healthchecks check `mjk-backup` is green (§7); `/srv/mjk/backup-staging` is empty again (`ls -A /srv/mjk/backup-staging`).

- A run that fails with the repository unreachable, a TLS timeout or exit 69 means R2's S3 endpoint is not inside the `cf4` set of `table inet mjk` [U box: A§17.4], or `cf4` is stale. Check with `docs/runbooks/cloudflare.md` §6 and write the answer into A§17.4. Also read `nft list table inet mjk | grep -B1 -A1 'drop'` for a moved counter.
- Exit 78: a missing or unreadable secret file, a bad `MJK_R2_ENDPOINT` (it must be https and have no path), a wrong restic password, or `repo_missing` (no `restic init` yet, a wrong bucket, or a lost `config`: restore it from the offline copy, never init again over a bucket that has data). The fixed code names which.
- If the unit itself fails before the container starts (`Operation not permitted`, a systemd sandbox message), the unit's hardening (ProtectSystem=strict, MemoryDenyWriteExecute, RestrictAddressFamilies) is [U box] with the Go docker CLI: `systemd-analyze security mjk-backup.service` and relax the one setting that the journal names, in `deploy/host/systemd/mjk-backup.service` through a PR, then `deploy/bin/mjk-install`.

Run it a second time (two consecutive backups) before the lock tests in §5.

## 4. The workstation

Install restic 0.19.1 on your workstation (the same version as the image; a release binary from github.com/restic/restic, checked against the release's `SHA256SUMS`). Keep the workstation key as an AWS credentials file and the restic password as a file, both mode 0600, outside any repository:

```bash
mkdir -p ~/.config/mjk && chmod 700 ~/.config/mjk
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "<workstation key id>" "<workstation secret>" > ~/.config/mjk/r2_workstation   # type the values from the password manager, with HISTFILE= set
chmod 600 ~/.config/mjk/r2_workstation
# the restic password: write it from the password manager into ~/.config/mjk/restic_password (0600)

export RESTIC_REPOSITORY="s3:https://<account id>.eu.r2.cloudflarestorage.com/mjk-backup"
export RESTIC_PASSWORD_FILE=$HOME/.config/mjk/restic_password
export AWS_SHARED_CREDENTIALS_FILE=$HOME/.config/mjk/r2_workstation
export AWS_DEFAULT_REGION=auto
restic snapshots
```

Expected: the snapshots of the nightly runs, host `mjk`, tag `nightly`.

## 5. The lock tests (criterion 10, [box] and [U box])

Goal: with the VM's key, deleting or overwriting an object under `data/`, `snapshots/` or `index/` younger than 28 days fails, and under `keys/` or `config` at any age; `locks/` stays free; the key cannot touch `mjk-media`; two consecutive backups leave no lock file; and `restic forget --prune` with the workstation key works.

The checks on objects use `curl` with the VM key read from its file by the shell and given to curl as a config on stdin, never as an argument (`printf` is a builtin; the key is not in `ps`). On the VM:

```bash
HISTFILE=
EP=$(sed -n 's/^MJK_R2_ENDPOINT=//p' /etc/mjk/mjk.env); B=$(sed -n 's/^MJK_R2_BUCKET_BACKUP=//p' /etc/mjk/mjk.env)
KF=/etc/mjk/secrets/r2_backup_put
# r2 <method> <bucket> <key> [curl args]: prints the HTTP status. SigV4 by curl; the key reaches curl on stdin.
r2() { local m=$1 bucket=$2 key=$3; shift 3
  { printf 'user = "%s:%s"\n' "$(awk -F' *= *' '/aws_access_key_id/{print $2}' "$KF")" "$(awk -F' *= *' '/aws_secret_access_key/{print $2}' "$KF")"
    printf 'aws-sigv4 = "aws:amz:auto:s3"\n'; } |
    curl -sS -K - -o /dev/null -w '%{http_code}\n' -X "$m" -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' "$@" "$EP/$bucket/$key"; }
```

If R2 refuses the signature (400/403 on the very first PUT in step a), curl's SigV4 is not enough here [U box]: use `rclone` or `aws s3api` instead, with the same key file, and write the working form back into this runbook.

a. **The lock holds under `data/` and for `config`** (a canary object per prefix; the canary stays 28 days and is harmless: restic reads only the objects it knows by hash, and a canary with a non-hash name is not one):

```bash
S=$(date +%s)
r2 PUT "$B" "data/00/lock-test-$S"  --data-binary canary     # 200: a new object is allowed
r2 PUT "$B" "data/00/lock-test-$S"  --data-binary changed    # expect a 4xx (403 or 409): overwrite refused
r2 DELETE "$B" "data/00/lock-test-$S"                        # expect a 4xx: delete refused
r2 PUT "$B" "config-lock-test-$S"   --data-binary canary     # 200
r2 DELETE "$B" "config-lock-test-$S"                         # expect a 4xx
r2 PUT "$B" "keys/lock-test-$S"     --data-binary canary     # 200
r2 DELETE "$B" "keys/lock-test-$S"                           # expect a 4xx: keys/ is locked for good
```

[U box] **After day 28:** repeat the `config-lock-test-$S` and `keys/lock-test-$S` DELETE once both canaries are older than 28 days (note `$S` in the PR). Both must still be refused; that is what the indefinite rule adds over the 28-day one. Also try the real files once the repository is older than 28 days: `r2 DELETE "$B" config` must be refused (a 4xx). If it ever succeeds, stop the backups, restore `config` from the offline copy, fix the rule and record it in A§17.6.

b. **A real snapshot under `snapshots/` cannot be deleted.** After two backups there are two snapshots. Try to forget the older one with the VM's own credentials (through the `backup` service, so the key stays in its container):

```bash
RO='-e RESTIC_REPOSITORY=s3:'"$EP/$B"' -e RESTIC_PASSWORD_FILE=/run/secrets/restic_password -e AWS_SHARED_CREDENTIALS_FILE=/run/secrets/r2_backup_put -e AWS_DEFAULT_REGION=auto'
mjkc --profile backup run --rm -T --entrypoint /usr/local/bin/restic $RO backup --no-cache snapshots
mjkc --profile backup run --rm -T --entrypoint /usr/local/bin/restic $RO backup --no-cache forget <id of the older snapshot>   # expect: an error (access denied / locked)
mjkc --profile backup run --rm -T --entrypoint /usr/local/bin/restic $RO backup --no-cache snapshots                          # both snapshots are still listed
```

The `index/` rule is checked by the prune in §6, which must write and delete there; prune never touches `keys/` or `config`.

c. **`locks/` stays free, and no file is left under it** after two consecutive backups:

```bash
r2 PUT "$B" "locks/lock-test-$S" --data-binary canary     # 200
r2 DELETE "$B" "locks/lock-test-$S"                       # 2xx: restic can remove its own lock files
mjkc --profile backup run --rm -T --entrypoint /usr/local/bin/restic $RO backup --no-cache list locks      # prints nothing
```

d. **The key cannot touch `mjk-media`:**

```bash
r2 GET mjk-media "?list-type=2&max-keys=1"                                               # expect 403
r2 PUT mjk-media "lock-test-$S" --data-binary canary                                     # expect 403
```

(If `mjk-media` does not exist yet, create it first (`docs/runbooks/cloudflare.md` §4); a missing bucket answers 404 and proves nothing.)

e. **Prune with the workstation key** (on the workstation, §4's environment):

```bash
restic forget --keep-daily 28 --prune --max-unused 0 --dry-run
restic forget --keep-daily 28 --prune --max-unused 0
restic check
```

On a young repository nothing is older than 28 days, so this run mostly proves that restic can take and release its lock and rewrite `index/` under the lock. Repeat it after a month. Write the result into A§17.6 and ADR-0011, and:
- if `forget --prune` fails writing or replacing a recent `index/` file: take `index/` out of the lock rule (restic can rebuild its index) and record that in A§17.6 and ADR-0011's Revisit line (owner decision Q8);
- if it fails deleting a `data/` pack younger than 28 days: raise `--max-unused` (for example `5%`) so recent packs are not repacked, and record the cost (the bytes kept) in A§17.6;
- anything else: stop, keep the output, and ask before touching the lock rule.

Record in the PR: the status codes of a to d, the `list locks` output and the prune result.

## 6. Retention: weekly, from the workstation

Once a week (a calendar reminder; never on the VM, never with the VM's key). With §4's environment:

```bash
restic forget --keep-daily 28 --prune --max-unused 0
restic check --read-data-subset=5%
```

There are no weekly or monthly snapshots, so a deleted account leaves the backups within about 35 days (A§13.2) [U]. The cost of `--max-unused 0` (the bytes rewritten per week and the run time) is [U box]: note both after the first real prune and write them into A§17.6.

## 7. healthchecks.io

A separate free account for mjk, so no check group is shared with Waterheight or F1 (invariant 2).
1. Create a project `mjk` and two checks with these slugs: `mjk-worker` (period 1 hour, grace 30 minutes) and `mjk-backup` (period 1 day, grace 2 hours). Add your email as the notification.
2. Project Settings → Ping key: create it; write it to `/etc/mjk/secrets/hc_ping_key` (`docs/runbooks/install.md` §4). The worker and the host unit then ping `https://hc-ping.com/<key>/<slug>`.
3. Test from the VM: `mjk-ping ok` (the dashboard shows a ping), `mjk-ping fail` (the check turns red), then `mjk-ping ok` again.
4. The worker pings at start and hourly: success while the newest applied `museum_sync_run` (the seed included) finished under 8 days ago, else `/fail`. Before the first `sync-museums --seed` it therefore reports `/fail`. Without a key file it is disabled and logs the code `healthchecks_disabled` once (`mjkc logs worker | grep healthchecks`).

## 8. What is and is not backed up

Backed up: the database (minus the excluded tables' data) and `/srv/mjk/originals`. Not backed up: the R2 derivatives (a worker job rebuilds them, P3b), the basemap tiles (re-extracted), the quarantine, export bundles, `/srv/mjk/tiles-build`, `/srv/mjk/state` (rebuilt by `mjk-install` and `mjk-update`) and the images (in GHCR). The secrets are not in the backup: keep the restic password, the workstation key, the Admin token and the R2 keys in your password manager; without them a restore is impossible. The restore is `docs/runbooks/restore-drill.md`.
