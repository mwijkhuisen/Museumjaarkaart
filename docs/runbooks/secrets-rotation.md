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

`db_postgres` is used only at the very first start of the volume (the superuser reaches the database over the container's local socket, which is `trust`, never over TCP). To rotate it, change the file and the role together:

```bash
openssl rand -hex 32 | newsecret db_postgres 63001
{ printf "ALTER ROLE postgres PASSWORD '%s';\n" "$(cat /etc/mjk/secrets/db_postgres)"; } | mjkc exec -T db psql -X -U postgres -d mjk
```

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

## 4. The restic password (`restic_password`, 63011)

The repository is encrypted with a key derived from the password, so changing the file alone makes every backup unreadable. Add the new password as a second restic key first, from the workstation (`docs/runbooks/backup.md` §4 environment):

```bash
restic key list
restic key add                    # prompts for the new password (type it, or use the password manager's prompt)
```

Then write the new password into `/etc/mjk/secrets/restic_password` on the VM (`newsecret restic_password 63011`), run a backup (`systemctl start mjk-backup.service`) and check it works with the new key. Only then remove the old key: `restic key remove <old id>`. Deleting a key object under `keys/` inside its 28-day lock is refused [U box, `docs/runbooks/backup.md` §5]; if it is, leave both keys and remove the old one once the old key file is 28 days old. Record the new password in your password manager before anything else.

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

The `write:packages` token of the `production` environment (`docs/runbooks/cloudflare.md` §8) expires after 90 days. Before it does: create a new classic token with that one scope, replace the environment secret, delete the old token, and watch the next `release` run. If it was ever exposed, rotate it at once and check the packages' recent versions (package → Versions) for any you did not publish.

## 8. Secrets that arrive later

`lettermint_api_token` (63008), `app_keys` (63012) and `r2_media_rw` (63009) come with P2a and P3b; their rotation is added to this runbook then. A new `app_keys` pepper invalidates only pending codes and unused invites [U overlap window, A§17.3].
