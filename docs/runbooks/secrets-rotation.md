# Runbook: rotating secrets

For the owner. One section per secret: when, how, what restarts, how to check. The code wins where this text differs. If a secret may have leaked (a log, a screenshot, a laptop), rotate it now and read `docs/runbooks/incident.md` §6 as well.

Rules (CLAUDE.md invariant 1): a secret is only ever a file under `/etc/mjk/secrets` (`root:<gid> 0440`) or a value in your password manager. Never an argument, an environment variable, a message or a commit. Work in a root shell on the VM with `HISTFILE=` set. Compose mounts a secret file into the container when the container is created, and the roles read it at start, so a changed file takes effect when the consumers are recreated.

```bash
HISTFILE=; umask 077
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
# write a new value without a window of a wrong owner or mode: a new file, then an atomic replace
newsecret() { # <name> <gid>: reads the value from stdin
  cat > "/etc/mjk/secrets/.$1.new" && chown "root:$2" "/etc/mjk/secrets/.$1.new" && chmod 0440 "/etc/mjk/secrets/.$1.new" &&
    mv -f "/etc/mjk/secrets/.$1.new" "/etc/mjk/secrets/$1"
}
```

Check after every rotation that `mjk-install` still accepts the files (names, owners and modes only, `docs/runbooks/install.md` §5):

```bash
cd /root/mjk-checkout && deploy/bin/mjk-install | tail -3
```

## 1. Database logins and the superuser

Secrets: `db_mjk_migrator` (63002), `db_mjk_api` (63003), `db_mjk_ssr` (63004), `db_mjk_worker` (63005), `db_mjk_backup` (63006), `db_postgres` (63001). When: yearly, after a suspected leak, after a person with access leaves.

The passwords are set in the database by `roles.sql` (it ran once, from the init directory of the new volume). After a change to a login's file, run it again by hand: it is idempotent and reads the files with `pg_read_file` inside the `db` container, so no password is ever in SQL text or a statement log. It changes cluster-wide state (roles, `CONNECT` grants): there is one database per cluster here, so never point it at a shared server.

```bash
openssl rand -hex 32 | newsecret db_mjk_api 63003          # repeat for the login you rotate (gids above)
mjkc exec -T db psql -X -U postgres -d mjk -f /docker-entrypoint-initdb.d/00-roles.sql
mjkc up -d --force-recreate api                             # the daemon of the login you rotated: api, ssr or worker
```

Restart the daemons that use the login (`db_mjk_api`: `api`; `db_mjk_ssr`: `ssr`; `db_mjk_worker`: `worker`); the job logins (`migrate`, `backup`, `sync-museums`, `admin`) read their file at each run. New connections with the old password fail from the moment `roles.sql` ends until the recreate (seconds). The password format is 24 or more characters of `A-Za-z0-9_-`; `openssl rand -hex 32` fits.

`db_postgres` is used only at the very first start of the volume (the superuser reaches the database over the container's local socket, which is `trust`, never over TCP). To rotate it, change the file and the role together. As with `roles.sql`, the server reads the new password from the secret file itself (`pg_read_file`), so it is never in an argument list, in the SQL text that `pg_stat_activity` or a statement log would show, or in a psql history (`-X`, and the statement comes on stdin, not from an interactive session); an error is replaced by a fixed text, because its context could quote the statement:

```bash
openssl rand -hex 32 | newsecret db_postgres 63001
mjkc exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d mjk <<'SQL'
DO $$
DECLARE pw text := btrim(pg_read_file('/run/secrets/db_postgres'), E' \t\r\n');
BEGIN
  IF pw !~ '^[A-Za-z0-9_-]{24,}$' THEN RAISE EXCEPTION USING ERRCODE = '22023'; END IF;
  EXECUTE format('ALTER ROLE postgres PASSWORD %L', pw);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'rotation of postgres failed (SQLSTATE %)', SQLSTATE;
END $$;
SQL
```

Never type the password into `ALTER ROLE … PASSWORD '…'` or psql's command line. If you prefer to type it, `mjkc exec db psql -X -U postgres -d mjk` and then `\password postgres` sends only the SCRAM verifier (psql computes it); with `PSQL_HISTORY=/dev/null` set inside the container (`mjkc exec -e PSQL_HISTORY=/dev/null db …`) nothing is kept.

Check: `mjkc ps` all healthy; `curl -s -H 'Host: <domain>' http://127.0.0.1:8280/api/v1/healthz`; `mjkc logs --tail 20 api` shows no `db_` error codes.

## 2. The tunnel token (`cf_tunnel_token`, 63007)

When: yearly, after a leak. In Zero Trust → Networks → Tunnels → `mjk` → Refresh token (the old token stops working), copy the new one and:

```bash
read -rs -p 'new tunnel token: ' v; echo; printf '%s' "$v" | newsecret cf_tunnel_token 63007; unset v
mjkc up -d --force-recreate cloudflared
mjkc ps cloudflared; curl -sI https://<domain>/ | head -3
```

The site is unreachable between the refresh and the recreate (about a minute). Never touch the Waterheight or F1 tunnels.

## 3. The VM's R2 key (`r2_backup_put`, 63010)

When: yearly, after a leak. Create a new Object Read & Write token on `mjk-backup` only (`docs/runbooks/backup.md` §2), write the AWS credentials file, then revoke the old token in the dashboard:

```bash
read -rs -p 'access key id: ' id; echo; read -rs -p 'secret access key: ' key; echo
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$key" | newsecret r2_backup_put 63010; unset id key
systemctl start mjk-backup.service; journalctl -u mjk-backup.service -n 20 --no-pager
```

The backup container reads the file at each run; no restart is needed. The workstation key and the Admin token are rotated in the dashboard and your password manager only; they are not on the VM.

## 3b. The media R2 key (`r2_media_rw`, 63009)

When: yearly, after a leak, or after `store_denied` in a `tiles_*` job. Create a new Object Read & Write token on `mjk-media` only (`docs/runbooks/cloudflare.md` §4), write the AWS credentials file, then revoke the old token in the dashboard:

```bash
read -rs -p 'access key id: ' id; echo; read -rs -p 'secret access key: ' key; echo
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$key" | newsecret r2_media_rw 63009; unset id key
mjkc up -d --force-recreate worker
mjkc ps worker; mjkc logs --tail 20 worker
```

The worker mounts the file when its container is created and the tiles job reads it each time it runs, so a recreate is needed. The next `tiles_*` job proves the new token (a wrong one ends `store_denied`, `docs/runbooks/tiles-refresh.md` §6): run `mjkc --profile tools run --rm admin tiles refresh` and read the worker log. A running tiles job is cut off by the recreate (`tiles_aborted`, retried), so rotate between runs.

## 4. The restic password (`restic_password`, 63011)

The repository is encrypted with a key derived from the password, so changing the file alone makes every backup unreadable. Add the new password as a second restic key first, from the workstation (`docs/runbooks/backup.md` §4 environment):

```bash
restic key list
restic key add                    # prompts for the new password (type it, or use the password manager's prompt)
```

Then write the new password into `/etc/mjk/secrets/restic_password` on the VM (`newsecret restic_password 63011`), run a backup (`systemctl start mjk-backup.service`) and check it works with the new key. Record the new password in your password manager before anything else, and refresh the offline copy of `keys/` (`docs/runbooks/backup.md` §1).

The old key stays: `keys/` is locked indefinitely (ADR-0011), so `restic key remove <old id>` is refused, and that is the point (a VM key must never be able to delete a key file). The old password therefore still opens the repository. After a **leaked** restic password a key rotation is not enough, because restic's master key does not change: create a new repository in a new bucket from the workstation (`docs/runbooks/backup.md` §1 and §3, with a new password), point `MJK_R2_BUCKET_BACKUP` at it, and keep the old bucket until its 28-day history has aged out of use.

## 5. The healthchecks ping key (`hc_ping_key`, 63013)

In the healthchecks.io project settings, create a new ping key and revoke the old one:

```bash
read -rs -p 'new ping key: ' v; echo; printf '%s' "$v" | newsecret hc_ping_key 63013; unset v
mjkc up -d --force-recreate worker
mjk-ping ok
```

The host unit `mjk-backup.service` reads the file at each run (as root); the worker at start. Without a valid key the worker logs `healthchecks_disabled` or `healthchecks_key_invalid` and sends nothing.

## 6. Cloudflare Access values (config, not secrets, but they gate the admin host)

If the Access application is recreated, its AUD tag changes: put the new 64 hex characters in `CF_ACCESS_AUD` in `/etc/mjk/mjk.env` and `mjkc up -d --force-recreate api`. Until then every admin-host request is a 401 `access_refused` (the safe direction). The team name changes only if you rename the Zero Trust team.

## 7. GitHub: `GHCR_PUSH_TOKEN`

The `write:packages` token of the `production` environment (`docs/runbooks/cloudflare.md` §8) expires after at most 90 days. Rotate it **before** the expiry, at the calendar reminder two weeks ahead (a `release` run with an expired token fails at `docker login`, and `:main` then does not move):

1. Create the new token exactly as in `docs/runbooks/cloudflare.md` §8 step 2: `https://github.com/settings/tokens/new?scopes=write:packages`, `repo` unticked, `write:packages` only, an expiry of at most 90 days.
2. Replace the secret `GHCR_PUSH_TOKEN` of the environment `production` with it (Settings → Environments → `production` → `GHCR_PUSH_TOKEN` → Update).
3. Delete the old token (Settings → Developer settings → Personal access tokens → Tokens (classic) → the old `mjk release` → Delete).
4. Set the next calendar reminder, two weeks before the new expiry.
5. Watch the next `release` run: `docker login` succeeds and `:main` moves.

If the token was ever exposed, rotate it at once, and check the recent versions of every package of your account (package → Versions), F1's and Waterheight's included, for any you did not publish (`docs/runbooks/incident.md` §6).

## 8. Secrets that arrive later

`app_keys` (63012) and `lettermint_api_token` (63008) arrived with P2a; their rotation is added to this runbook with the P2a docs. A new `app_keys` pepper invalidates only pending codes and unused invites [U overlap window, A§17.3].
