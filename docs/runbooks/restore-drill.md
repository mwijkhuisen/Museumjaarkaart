# Runbook: restore drill

For the owner. Monthly (and once for P1e's criterion 9): restore the latest snapshot into a throw-away database, compare row counts with production, check a sample of originals by sha256, and see that the excluded tables come back empty. It also measures the RTO (A§17.6). The code wins where this text differs.

Safety: the drill cannot touch production. It runs with the workstation key (§1), restores into a directory and into a throw-away PostgreSQL container on its own Docker network that has no host port and is not named `mjk-*`, `rws` or `f1`. Only the two read-only count queries touch production (§4). Do not run the drill on the VM if disk is tight: the restore needs the size of the dump plus the originals.

Shorthand for the VM (production counts only):

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
```

Start a stopwatch: the RTO is the time from §1 to the end of §5, plus the reinstall time of `docs/runbooks/install.md` (A§17.6 estimates about a day, [U]).

## 1. Restore the files

On the workstation, with the environment of `docs/runbooks/backup.md` §4 (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_DEFAULT_REGION`, and `RESTIC_KEY_HINT`, the real key's full id from the password manager: restic tries it first, so key files planted under `keys/` should not stop the restore, A§17.6 [U]):

```bash
D=$(mktemp -d /var/tmp/mjk-drill.XXXXXX); echo "$D"
restic snapshots --host mjk --tag nightly
restic restore latest --host mjk --tag nightly --target "$D"
ls -l "$D/srv/mjk/backup-staging/mjk.dump"; du -sh "$D/srv/mjk/originals" 2>/dev/null || echo 'no originals yet (P3b)'
```

`restic restore` verifies what it writes. To pick a snapshot other than the latest, give its id instead of `latest`.

## 2. A throw-away database

```bash
docker network create drill-net
PW=$(openssl rand -hex 16)
docker run -d --name drill-pg --network drill-net --tmpfs /var/lib/postgresql \
  -e POSTGRES_PASSWORD="$PW" \
  -e POSTGRES_INITDB_ARGS='--locale-provider=builtin --builtin-locale=C.UTF-8' \
  postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42
until docker exec drill-pg pg_isready -h 127.0.0.1 -U postgres; do sleep 1; done
docker exec drill-pg createdb -U postgres drill
docker cp "$D/srv/mjk/backup-staging/mjk.dump" drill-pg:/tmp/mjk.dump
docker exec drill-pg pg_restore -U postgres -d drill --no-owner --no-privileges --exit-on-error /tmp/mjk.dump
```

`--no-owner --no-privileges` because the five logins do not exist in the drill cluster; owners and grants are not part of what the drill proves. The dump is custom format: the `pg_restore` of the same major version (18) reads it. The extensions (`pg_trgm`, `unaccent`, `citext`) are created by the restore.

## 3. Row counts of the drill

```bash
docker exec -i drill-pg psql -X -At -U postgres -d drill <<'SQL' > /tmp/counts-drill.txt
SELECT format('SELECT %L, count(*) FROM public.%I', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname \gexec
SQL
wc -l /tmp/counts-drill.txt
```

## 4. Row counts of production, and the comparison (criterion 9)

On the VM (a read-only query as the superuser inside the `db` container; it prints counts, never rows):

```bash
mjkc exec -T db psql -X -At -U postgres -d mjk <<'SQL' > /tmp/counts-prod.txt
SELECT format('SELECT %L, count(*) FROM public.%I', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname \gexec
SQL
```

Copy `/tmp/counts-prod.txt` to the workstation (it holds table names and numbers only) and compare:

```bash
diff /tmp/counts-prod.txt /tmp/counts-drill.txt
```

Expected, in this order of importance:
1. Every table except the five below has the same count in both files. A table that gained rows after the snapshot (the nightly run is at 01:43; run the drill the next morning, and expect small differences in tables that change during the day, such as `museum_change` or `job`) is fine only if you can explain it; a table that is smaller than in production by a lot is a failed drill.
2. The tables whose data A§17.6 excludes come back **empty**: `job` now, and `session`, `email_code`, `auth_challenge` and `rate_limit` once P2a adds them. Their lines in `counts-drill.txt` read `<table>|0`, while production has rows. Confirm:

```bash
grep -E '^(job|session|email_code|auth_challenge|rate_limit)\|' /tmp/counts-drill.txt
```

The next drill is the first with the P2a and P2b tables: `app_user`, `invite`, `passkey`, `audit_log` and `content_ip_log` come back with production's counts, and `session`, `email_code`, `auth_challenge`, `rate_limit` and `job` (the dump's `--exclude-table-data` list, `apps/server/src/backup/plan.ts`) come back empty. Write both into A§17.6.

3. The structure is intact: the same tables exist in both files (the `diff` above shows a missing or extra table as a whole line).

An optional structure comparison. `pg_dump` 17.6+ and 18 write a random `\restrict` line, so strip it before comparing (CLAUDE.md gotcha):

```bash
docker exec drill-pg pg_dump -U postgres -d drill --schema-only | grep -v -E '^\\(un)?restrict ' > /tmp/schema-drill.sql
```

and the same from production (`mjkc exec -T db pg_dump -U postgres -d mjk --schema-only | grep -v -E '^\\(un)?restrict '`); the two differ only in ownership lines, which `--no-owner` dropped.

## 5. The originals

Empty until P3b adds uploads; when there are some, check a sample by sha256. On the VM, hash 20 random originals and compare with the restored files (the file names are the same under `/srv/mjk/originals`):

```bash
# on the VM
( cd /srv/mjk/originals && find . -type f | shuf -n 20 | xargs -r sha256sum ) > /root/originals-sample.sha256
# copy it to the workstation, then there:
( cd "$D/srv/mjk/originals" && sha256sum --check --quiet /path/to/originals-sample.sha256 ) && echo 'originals match'
```

A file uploaded after the snapshot is missing from the restore; that is not a failure, a mismatching hash is.

## 6. Deletions since the snapshot

Account deletions made after the snapshot must be re-applied before a real restore goes live (A§13.2, A§17.6): from production's `audit_log` when it survives, and for a full loss from the owner's deletion notices ("<account id> deleted <time>", ids only) [U]. A real restore keeps the site in maintenance until those deletions are re-run. Until accounts exist (P2a) there is nothing to re-apply; write "none yet" in the report.

## 7. Clean up, and the report

```bash
docker rm -f drill-pg; docker network rm drill-net; unset PW
rm -rf "$D" /tmp/counts-drill.txt /tmp/counts-prod.txt /tmp/schema-drill.sql
```

Report (in the PR for P1e, later in your notes; the status panel shows the last drill from P3c): the snapshot id and time; the result of each check above (counts equal, excluded tables empty, originals match or "none yet"); the elapsed time of §1 to §5, which is your RTO figure for A§17.6; anything unexpected. Do the drill again once a month.
