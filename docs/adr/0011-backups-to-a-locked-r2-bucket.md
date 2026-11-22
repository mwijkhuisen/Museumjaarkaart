# ADR-0011: Backups: restic to a locked private R2 EU bucket

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** after P1e's [box] lock test (criterion 10) and the first restore drill, which prove (or not) restic with R2's bucket lock. Fallback, decided in P1e (owner Q8): if `restic forget --prune` fails on recent `index/` files, take `index/` out of the lock rule (restic can rebuild it) and record the change here and in A§17.6. Amended in P1e's security review (S1, S5): `keys/` and `config` are locked indefinitely, an offline copy of both is kept, and the backup job never creates a repository.

## Context

- Members' accounts, visits, reviews and photo originals cannot be re-fetched. F1 runs without backups because all its data can be (F1 ADR-0002); this site cannot.
- The VM is a single failure domain: one disk, one home line (ADR-0003).
- Waterheight ADR-0011: restic to an EU bucket with versioning and Object Lock; the host key cannot delete versions; pruning runs from the owner's workstation; a monthly restore drill.
- The media bucket already lives on R2 in the owner's Cloudflare account (ADR-0008).
- R2's token types are Admin R/W, Admin R, Object R/W and Object R, scoped per bucket: none writes without being able to delete, and object versioning is not documented [U]. A bucket lock rule blocks deletion and overwriting per prefix for a set time, and a token with bucket-configuration rights can remove it.

## Decision

- **A nightly `backup` job** (`mjk-backup.timer` at 01:43 Europe/Amsterdam, running `mjk-backup.service` on the host under the deploy lock, D24, A§17.6): `pg_dump -Fc --exclude-table-data` for `session`, `email_code`, `auth_challenge`, `rate_limit` and `job` (a restore signs everyone out), as `mjk_backup` (a member of `pg_read_all_data` and nothing else) into `/srv/mjk/backup-staging`, then restic 0.19.1 of the dumps and `/srv/mjk/originals`.
- **Target:** the private R2 EU bucket `mjk-backup`, in the same Cloudflare account as `mjk-media`, with bucket lock rules (owner action A2) that keep objects under `data/`, `index/` and `snapshots/` for 28 days [U], and `keys/` and `config` **indefinitely**. restic writes `config` and the key files once, at `init` (and `key add`), and never prunes them: with a 28-day age lock the VM's key could delete them from day 29 and make every snapshot, the locked ones included, undecryptable. The owner also keeps an offline copy of `config` and every `keys/*` object (small, already encrypted) in the password manager. `locks/` is left out so restic can remove its own lock files [U box: `docs/runbooks/backup.md` §5].
- **The repository is created once, by the owner from the workstation** (`restic init`, `docs/runbooks/backup.md` §3). The nightly job never runs `init`: a missing repository (restic exit 10: a wrong bucket or prefix, a lost `config`) is exit 78 `repo_missing`, so the ping fails instead of a new repository with a new key starting silently.
- **Keys:** the VM's key `r2_backup_put` (GID 63010) is an Object Read & Write token scoped to `mjk-backup` only. R2 has no put-only permission and no object versioning [U box], so the lock rule is the only thing that stops it deleting recent history. Lock rules change only with an Admin token kept in the owner's password manager, never on the VM. `restic_password` (GID 63011) is a file secret. `restic forget --prune` runs from the owner's workstation with its own token (Object R/W on `mjk-backup`, never on the VM).
- **Retention:** `restic forget --keep-daily 28 --prune --max-unused 0` [U box cost], weekly. No weekly or monthly snapshots and no unused data left in partly used packs, so a deleted account ages out of the backups within ~35 days (A§13.2) [U].
- **Restore drill** monthly, on a throw-away database. Deletions since the snapshot are re-applied from production's `audit_log` when it survives. For a full loss, they come from the owner's deletion notices: the deletion job mails the owner "<account id> deleted <time>" (ids only) [U]. The restore runbook keeps the site in maintenance until those deletions are re-run.
- **Egress:** `mjk-backup-egress`, tcp/443 to Cloudflare's ranges only (A§17.4). A healthchecks ping on success and `/fail` otherwise, sent by the host unit with the key on `curl -K -` stdin, from a separate healthchecks account for mjk (owner, P1e Q4 and Q5). The `backup` is its own image, `ghcr.io/mwijkhuisen/mjk-backup` (the server image plus `pg_dump` 18.6 and restic 0.19.1, P1e Q2), and its S3 credentials file is `r2_backup_put` in AWS format.
- **Not backed up:** the R2 derivatives (rebuilt from the originals), the basemap tiles (rebuilt) and the quarantine.

## Consequences

- RPO ≤ 24 h for the database and the originals. Once the lock is proven, ransomware on the VM cannot erase the last 28 days of history, nor the repository's `config` and keys that decrypt it.
- A restic key can be added but never removed (its object is locked for good). Rotating `restic_password` therefore leaves the old key file in place; after a leaked password the remedy is a new repository (a new bucket, `docs/runbooks/secrets-rotation.md` §4), because restic's master key does not change with a key rotation. The Admin token could remove the rule, so it never sits on the VM.
- **Accepted risk** (owner, 2026-11-01): media and backups sit with one vendor in one account, so losing or compromising that account hits both. The originals on the VM survive that case.
- The owner keeps a workstation key and looks at the drill result each month.
- Cost within or near R2's free tier [U] (A§19). CI runs restic against Chainguard MinIO without a lock: MinIO's Object Lock needs versioning (a delete adds a marker and succeeds) and is bucket-wide, so it cannot model R2's per-prefix lock rule; P1e's [box] criterion and the restore drill prove the lock.

## Alternatives rejected

- **Waterheight's EU S3 bucket provider:** proven with restic and Object Lock, but a second account, DPA and key set; the owner chose R2 (D24).
- **Backblaze B2 or Scaleway:** cheap, but a second vendor for one bucket.
- **No backups, like F1:** user content cannot be re-fetched.
- **Originals only on the VM disk:** one disk failure would lose every member's photos.
