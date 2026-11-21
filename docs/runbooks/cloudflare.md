# Runbook: Cloudflare and GitHub settings

For the owner. Cloudflare is not code (A§17.7): every setting the stack depends on is listed here, with the check that proves it. It covers owner action A2, the [owner] criteria 12 and 13 of P1e, and the hand-kept firewall sets. The code wins where this text differs: report the difference.

Rules (CLAUDE.md invariants 2 and 3): mjk has its own zone, its own tunnel, its own Access application and its own R2 account scope. Never reuse the Waterheight or F1 tunnel, Access application or tokens, and never put an account-wide token on the VM.

## 1. The zone

- Add `<domain>` as a zone (A1). SSL/TLS mode Full is enough: the tunnel carries plain HTTP from `cloudflared` to Caddy on the private network, and TLS ends at Cloudflare's edge.
- Always Use HTTPS on. Caddy's own `X-Forwarded-Proto: http` → 308 is the backstop.
- Do not enable Cloudflare's HSTS setting: Caddy sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` itself (A§15.6). Preload is a later decision, once the brand is final.
- DNS records for `<domain>` and `admin.<domain>` are created by the tunnel's public hostnames (§2). `media.<domain>` is the R2 custom domain (§4).

## 2. The tunnel

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `mjk`.
2. Copy only the token (the long string after `--token` in the install command shown) and write it to `/etc/mjk/secrets/cf_tunnel_token` as `docs/runbooks/install.md` §4 describes. Do not run the dashboard's install command anywhere.
3. Public hostnames (both to the same service):
   - `<domain>` → HTTP `caddy:80`
   - `admin.<domain>` → HTTP `caddy:80`
   No path, no "No TLS Verify" option, no third hostname. `caddy` resolves on `mjk-tunnel-edge`, where `cloudflared` (10.63.6.10) and Caddy meet.
4. Check on the VM, after the stack is up:

```bash
mjkc() { docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env "$@"; }
mjkc ps cloudflared                       # healthy: its check is `tunnel --metrics 127.0.0.1:20241 ready`
mjkc logs --tail 20 cloudflared           # "Registered tunnel connection" lines
curl -sI https://<domain>/ | head -5      # 200 from the site, through Cloudflare
```

`cloudflared` runs with `--no-autoupdate` and `--management-diagnostics=false`. Update it by changing its pin in `deploy/compose.yaml` through a PR (a digest at least 7 days old), running `deploy/bin/mjk-install`, then `systemctl start mjk-update.service`: it deploys the changed compose file with the same images (`docs/runbooks/install.md` §11).

## 3. The Access application on `admin.<domain>` (A§16.2, ADR-0004)

Zero Trust → Access → Applications → Add an application → Self-hosted.

| Setting | Value |
|---|---|
| Application domain | `admin.<domain>`, with the path left empty (it covers the whole hostname, `*`) |
| Session duration | 24 hours [U: the owner may shorten it] |
| Identity provider | One-time PIN only |
| Policy | one Allow policy, Include: Emails, your own address only |
| Not allowed | any Bypass policy, any Everyone or "Any valid email" include, a second application whose path overlaps this one |

After saving, note two values for `/etc/mjk/mjk.env`:
- `CF_ACCESS_TEAM`: the label of your team domain, `<team>.cloudflareaccess.com`.
- `CF_ACCESS_AUD`: the application's Audience (AUD) tag, 64 lowercase hex characters.

Then recreate the api so it reads them (`env_file` is read at container creation):

```bash
mjkc up -d --force-recreate api
```

The api checks the Access JWT itself on every request whose `Host` is `admin.<domain>` (A§9), so the Access application is the first lock and the api the second: `cloudflared` is not trusted to enforce it.

## 4. R2

Jurisdiction European Union for both buckets, chosen when they are created (it cannot change later; the S3 endpoint is the `.eu.` form: `https://<account id>.eu.r2.cloudflarestorage.com`).

| Bucket | Access | Settings |
|---|---|---|
| `mjk-backup` | private | the lock rule and the tokens of `docs/runbooks/backup.md` §1 and §2 |
| `mjk-media` | public through `media.<domain>` only | custom domain `media.<domain>`; the `r2.dev` public URL off; CORS for GET only, origin `https://<domain>` (the tiles of P1d); a Transform Rule on `media.<domain>` adding `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` to every object; objects carry their own `Cache-Control` (A§12) |

Tokens, one per bucket, Object Read & Write, none account-wide: one for `mjk-media` (arrives with P3b as `r2_media_rw`), one for `mjk-backup` (`r2_backup_put`, on the VM), one workstation token on `mjk-backup` (never on the VM). The Admin token that can change lock rules stays in your password manager.

## 5. Rules

- **Cache Rules** (A§17.7, Waterheight ADR-0021 §8), in this order:
  1. host `<domain>`, path not under `/api/` → Eligible for cache; Edge TTL "Use cache-control header if present, bypass cache if not";
  2. host `<domain>`, method GET, path under `/api/v1/` except `/api/v1/me`, `/api/v1/auth/`, `/api/v1/uploads` and `/api/v1/museums/near` → the same mode;
  3. `media.<domain>` path `/p/*` → eligible, Edge TTL override 4 h [U], browser TTL from the origin (A§12).
  Nothing on `admin.<domain>`. Never "Cache Everything" and never an Edge TTL that ignores the origin outside `media.<domain>`.
- **Rate limiting**: one rule on `/api/v1/auth/*` before P2a opens sign-up; its numbers are decided in P2a.
- **Script injections stay off** (the CSP allows no third-party and no inline script, and the privacy page promises no analytics): Rocket Loader, Auto Minify, Email Address Obfuscation, Cloudflare Web Analytics (automatic setup), Zaraz, Mirage and Polish, and Bot Fight Mode's JavaScript detections [U]. Check from outside:

```bash
curl -s https://<domain>/ | grep -i -E 'beacon|cloudflareinsights|rocket|email-decode' || echo 'no injected script'
curl -sI https://<domain>/ | grep -i -E '^(set-cookie|content-security-policy)' | tr -d '\r'      # no Set-Cookie; the CSP of A§15.6
```

## 6. Checking `cf4` and `cf_tunnel4` by hand

`deploy/host/nftables/mjk.nft` holds two Cloudflare sets that the agent wrote from its knowledge and never fetched (agents never call Cloudflare). Check them against the live lists now, and again every few months. Run on your workstation, in a checkout:

```bash
curl -fsS https://www.cloudflare.com/ips-v4 | sort > /tmp/cf-live.txt
sed -n '/set cf4 {/,/set cf_tunnel4 {/p' deploy/host/nftables/mjk.nft | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' | sort > /tmp/cf-ours.txt
diff /tmp/cf-live.txt /tmp/cf-ours.txt && echo 'cf4 matches'
```

For `cf_tunnel4` (198.41.192.0/24 and 198.41.200.0/24), read Cloudflare's "Tunnel with firewall" documentation page for the current IPs and ports (tcp and udp 7844), and confirm that the tunnel's regions resolve into the set:

```bash
getent ahostsv4 region1.v2.argotunnel.com region2.v2.argotunnel.com | awk '{print $1}' | sort -u
```

Every address must lie inside 198.41.192.0/24 or 198.41.200.0/24. A difference is a change to `mjk.nft` through a PR, then `deploy/bin/mjk-install` (it reloads the table, and `mjk-resolvers` refills `resolvers4`). A stale `cf4` shows up as the backup or the Access certs failing with a connection timeout (`docs/runbooks/incident.md` §5). Also confirm with the first backup run that R2's S3 endpoint lies inside `cf4` [U box] (`docs/runbooks/backup.md` §3).

## 7. Account settings

- The CSAM Scanning Tool on (Cloudflare dashboard, Caching → Configuration).
- Record that Cloudflare's DPA (Self-Serve Subscription Agreement §6.1) covers the account, with the version and the date, in the place A2 names (`docs/legal/processors.md` arrives in P3d; until then a note in the PR).
- An email address for Cloudflare notices that you read.

## 8. GitHub: GHCR, the `production` environment and A§16.3 (criterion 13, [owner])

GHCR write access is code execution on the VM, so `mjk-update` pulls only what the `release` job publishes, and only that job can write. You chose A§16.3's condition (2): a branch workflow can never obtain a GHCR write token.

1. **Packages.** For each of `mjk-server`, `mjk-web` and `mjk-backup` (github.com → your profile → Packages → the package → Package settings): visibility Public (the VM pulls anonymously, and the images hold no secret); under "Manage Actions access", this repository with the role Read, never Write. The first push creates a package, so do this after the first release, and check it again after every new package.
2. **The credential.** Create a classic personal access token with the scope `write:packages` only (fine-grained tokens cannot reach packages), short-lived (90 days), and put it in the `production` environment as the secret the workflow diff names (`GHCR_PUSH_TOKEN` in the lead's draft). It must exist nowhere else: not a repository secret, not an organisation secret.
3. **The environment.** Settings → Environments → `production`: Required reviewers: you; Deployment branches: Selected branches, `main` only. Nothing else gets this environment.
4. **The workflow diff.** The jobs `deploy` and `release` and the new `needs` of the `ci` aggregate are a diff under `.github/workflows/` that you push yourself (agents' credentials can change workflows, which is why the diff is yours to push and read line by line). In branch protection, `ci` stays required; if the diff's notes name `ci / deploy` as its own check, add it.
5. **The Claude GitHub App.** Settings → Applications → Installed GitHub Apps → Configure: confirm once that it holds no Administration permission.
6. **Record it.** In the PR write: "A§16.3 condition (2) holds as of <date>: the three packages give this repository Actions read access only; the push token exists only as a secret of environment `production` (reviewer: me, branch `main`); the Claude GitHub App has no Administration permission." That is criterion 13.

If a release ever pushes with another credential, stop and treat it as an incident (`docs/runbooks/incident.md` §6).

## 9. The Access checks (criterion 12, [owner])

In a private browser window:
1. Open `https://admin.<domain>/`. Expected: the Cloudflare Access login page, not the site.
2. Enter your own email, then the one-time PIN from the mail. Expected: through, and the page of the admin host (until P2a a static placeholder).
3. In another private window, enter a different email. Expected: no PIN mail arrives, or access denied.
4. Open the Access application's settings and compare with §3: the whole hostname, no Bypass, your email only, 24 h.

From a terminal, the two locks without a browser:

```bash
curl -sI https://admin.<domain>/ | head -5                                   # 302 to <team>.cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: admin.<domain>' http://127.0.0.1:8280/api/admin/x   # on the VM: 401, no Access JWT (the api's own lock)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: <domain>' http://127.0.0.1:8280/api/admin/x         # on the VM: 404 (admin exists only on its own host)
```

Note the result in the PR.
