# ADR-0011: Backups: restic to a locked private R2 EU bucket

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** after the first restore drill, which proves (or not) restic with R2's bucket lock.

## Context

- Members' accounts, visits, reviews and photo originals cannot be re-fetched. F1 runs without backups because all its data can be (F1 ADR-0002); this site cannot.
- The VM is a single failure domain: one disk, one home line (ADR-0003).
- Waterheight ADR-0011: restic to an EU bucket with versioning and Object Lock; the host key cannot delete versions; pruning runs from the owner's workstation; a monthly restore drill.
- The media bucket already lives on R2 in the owner's Cloudflare account (ADR-0008).
- R2's token types are Admin R/W, Admin R, Object R/W and Object R, scoped per bucket: none writes without being able to delete, and object versioning is not documented [U]. A bucket lock rule blocks deletion and overwriting per prefix for a set time, and a token with bucket-configuration rights can remove it.

## Decision

- **A nightly `backup` job** (`mjk-backup.timer`, D24, A§17.6): `pg_dump -Fc --exclude-table-data` for `session`, `email_code`, `auth_challenge`, `rate_limit` and `job` (a restore signs everyone out), as `mjk_backup` (a member of `pg_read_all_data` and nothing else) into `/srv/mjk/backup-staging`, then restic 0.19.1 of the dumps and `/srv/mjk/originals`.
- **Target:** the private R2 EU bucket `mjk-backup`, in the same Cloudflare account as `mjk-media`, with a bucket lock rule (owner action A2) that keeps objects under `data/`, `index/`, `snapshots/`, `keys/` and `config` for 28 days [U]. `locks/` is left out so restic can remove its own lock files [U P1e].
- **Keys:** the VM's key `r2_backup_put` (GID 63010) is an Object Read & Write token scoped to `mjk-backup` only. R2 has no put-only permission and no object versioning [U P1e], so the lock rule is the only thing that stops it deleting recent history. Lock rules change only with an Admin token kept in the owner's password manager, never on the VM. `restic_password` (GID 63011) is a file secret. `restic forget --prune` runs from the owner's workstation with its own token (Object R/W on `mjk-backup`, never on the VM).
- **Retention:** `restic forget --keep-daily 28 --prune --max-unused 0` [U P1e cost], weekly. No weekly or monthly snapshots and no unused data left in partly used packs, so a deleted account ages out of the backups within ~35 days (A§13.2) [U].
- **Restore drill** monthly, on a throw-away database. Deletions since the snapshot are re-applied from production's `audit_log` when it survives. For a full loss, they come from the owner's deletion notices: the deletion job mails the owner "<account id> deleted <time>" (ids only) [U]. The restore runbook keeps the site in maintenance until those deletions are re-run.
- **Egress:** `mjk-backup-egress`, tcp/443 to Cloudflare's ranges only (A§17.4). A healthchecks ping on success.
- **Not backed up:** the R2 derivatives (rebuilt from the originals), the basemap tiles (rebuilt) and the quarantine.

## Consequences

- RPO ≤ 24 h for the database and the originals. Once the lock is proven, ransomware on the VM cannot erase the last 28 days of history. The Admin token could remove the rule, so it never sits on the VM.
- **Accepted risk** (owner, 2026-11-01): media and backups sit with one vendor in one account, so losing or compromising that account hits both. The originals on the VM survive that case.
- The owner keeps a workstation key and looks at the drill result each month.
- Cost within or near R2's free tier [U] (A§19). CI tests restic against Chainguard MinIO with Object Lock, as Waterheight does.

## Alternatives rejected

- **Waterheight's EU S3 bucket provider:** proven with restic and Object Lock, but a second account, DPA and key set; the owner chose R2 (D24).
- **Backblaze B2 or Scaleway:** cheap, but a second vendor for one bucket.
- **No backups, like F1:** user content cannot be re-fetched.
- **Originals only on the VM disk:** one disk failure would lose every member's photos.
