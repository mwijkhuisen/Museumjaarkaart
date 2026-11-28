#!/usr/bin/env bash
# The CI e2e stack (A§18): db, migrate, seed, api, ssr, caddy and a TLS edge, then Playwright in the
# pinned image on the stack's network, then again with `ssr` stopped (the @ssr-down specs: a 502). Then
# the Caddy cases (deploy/e2e/caddy-cases.mjs, p1e criteria 3 and 4): against the real api and ssr, then
# with both replaced by an echo server (caddy-cases.yaml), then with the echo servers stopped, and last
# Caddy's own log, which must hold no client address, URI or query. P2a: the sign-up and sign-in specs (mail
# through the sink, the admin host through the Access stand-in), the log checks after them and, last, the
# @load pass (50 parallel password sign-ins, then the api's restart count and cgroup memory events). P3b: the
# no-network `media` role, the worker's R2 through the edge's r2.mjk.test, a fresh disk-guard file before each
# Playwright pass, and after the main pass the media container's restart count and cgroup memory events.
# Run from the repository root, after `pnpm --filter @mjk/web build`.
#   DBMATE_BIN=/path/to/dbmate deploy/e2e/stack.sh [playwright arguments, e.g. headers.spec.ts]
# DBMATE_BIN is a dbmate 2.36.0 binary (the workflow installs it, sha256-checked). PLAYWRIGHT_IMAGE
# defaults to the pinned image. Everything here is throw-away: random secrets, tmpfs databases.
set -euo pipefail

: "${DBMATE_BIN:?set DBMATE_BIN to a dbmate 2.36.0 binary}"
PLAYWRIGHT_IMAGE=${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea}

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[[ -d apps/web/dist/client/assets ]] || { echo "stack: run 'pnpm --filter @mjk/web build' first" >&2; exit 1; }

# One random secret per file: 32 characters of A-Za-z0-9_- (what dbUrl and roles.sql accept), readable
# by the containers' UID 63532 (0444 in a 0700 directory: the daemon bind-mounts the files).
E2E_SECRETS=$(mktemp -d)
export E2E_SECRETS DBMATE_BIN
for name in db_postgres db_mjk_migrator db_mjk_api db_mjk_ssr db_mjk_worker db_mjk_backup minio_root_user minio_root_password; do
  head -c 24 /dev/urandom | base64 | tr '+/' '-_' >"$E2E_SECRETS/$name"
  chmod 0444 "$E2E_SECRETS/$name"
done
# The media bucket's stand-in: the same two values as the AWS credentials file the R2 client reads (r2_media_rw).
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' \
  "$(<"$E2E_SECRETS/minio_root_user")" "$(<"$E2E_SECRETS/minio_root_password")" >"$E2E_SECRETS/r2_media_rw"
chmod 0444 "$E2E_SECRETS/r2_media_rw"
# P2a: a valid app_keys (four lines, each 32 random bytes as base64url without padding: apps/server/src/auth/keys.ts)
# and a random Lettermint token (the sink only checks that the header is there).
for name in otp_pepper invite_pepper code_seal altcha_hmac; do
  printf '%s=%s\n' "$name" "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
done >"$E2E_SECRETS/app_keys"
head -c 24 /dev/urandom | base64 | tr '+/' '-_' >"$E2E_SECRETS/lettermint_api_token"
chmod 0444 "$E2E_SECRETS/app_keys" "$E2E_SECRETS/lettermint_api_token"

# A throw-away CA and one leaf certificate for each outside name the api and the worker dial: Cloudflare Access's
# certs host (CF_ACCESS_TEAM=test-team) and Lettermint's API. The edge answers both (edge.Caddyfile) and `api` and
# `worker` trust the CA through NODE_EXTRA_CA_CERTS (compose.yaml); nothing in production code changes.
E2E_PKI=$(mktemp -d)
export E2E_PKI
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=mjk-e2e-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign \
  -keyout "$E2E_PKI/ca.key" -out "$E2E_PKI/ca.pem" 2>/dev/null
for host in test-team.cloudflareaccess.com api.lettermint.co r2.mjk.test; do
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$host" \
    -keyout "$E2E_PKI/$host.key" -out "$E2E_PKI/$host.csr" 2>/dev/null
  openssl x509 -req -in "$E2E_PKI/$host.csr" -CA "$E2E_PKI/ca.pem" -CAkey "$E2E_PKI/ca.key" -CAcreateserial -days 2 \
    -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$host") -out "$E2E_PKI/$host.pem" 2>/dev/null
done
chmod 0444 "$E2E_PKI"/*

# The api's disk guard (A§17.7, owner Q6) reads guard/disk, as mjk-tick writes it; a file older than 30 minutes
# refuses every upload, so it is written again before each Playwright pass. World-readable: the api runs as 63532.
E2E_GUARD=$(mktemp -d)
export E2E_GUARD
chmod 0755 "$E2E_GUARD"
write_guard() {
  printf 'free_pct=50\nchecked=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$E2E_GUARD/disk.tmp"
  chmod 0644 "$E2E_GUARD/disk.tmp"
  mv -f "$E2E_GUARD/disk.tmp" "$E2E_GUARD/disk"
}
write_guard

compose() { docker compose -p mjk-e2e -f deploy/e2e/compose.yaml "$@"; }

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)); then compose logs --no-color --tail 200 >&2 || true; fi
  compose down -v --remove-orphans >&2 || true
  rm -rf "$E2E_SECRETS" "$E2E_PKI" "$E2E_GUARD"
  exit "$rc"
}
trap cleanup EXIT

compose up -d --wait db
compose up -d minio
compose run --rm migrate
compose run --rm seed
# P2a, through the production CLI (`admin`, as mjk_api): the specs' invite (its code is the only thing parsed from
# the output, and never printed) and the owners' roles (one owner per engine, one of each role). seed-e2e.ts made the
# accounts; their emails are the ones in the Access JWTs. Then the Access stand-in: jwks.json for the edge, one JWT
# per owner, as the runner's user.
E2E_INVITE=$(compose run --rm -T admin invite create --uses 10 --days 1 | sed -n 's/^invite \([0-9A-Z]\{16\}\) valid until .*/\1/p')
[[ -n $E2E_INVITE ]] || { echo "stack: admin invite create printed no invite code" >&2; exit 1; }
compose run --rm -T admin user role owner_chromium admin >/dev/null
compose run --rm -T admin user role owner_webkit moderator >/dev/null
# P3b: one trusted photo member per engine (seed-e2e.ts), so an attached photo is published to the bucket stand-in.
compose run --rm -T admin user trust photo_chromium >/dev/null
compose run --rm -T admin user trust photo_webkit >/dev/null
access_jwts=$(compose run --rm -T --user "$(id -u):$(id -g)" -v "$E2E_PKI:/pki" access-stub)
{ read -r E2E_ACCESS_JWT_CHROMIUM; read -r E2E_ACCESS_JWT_WEBKIT; } <<<"$access_jwts"
for jwt in "$E2E_ACCESS_JWT_CHROMIUM" "$E2E_ACCESS_JWT_WEBKIT"; do
  [[ $jwt =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || { echo "stack: no Access JWT" >&2; exit 1; }
done
export E2E_INVITE E2E_ACCESS_JWT_CHROMIUM E2E_ACCESS_JWT_WEBKIT
# The fixture tiles in the bucket stand-in (waits until minio answers).
compose run --rm tiles

# MJK_PROFILE picks profile-<name>.caddy, and only `prelaunch` ships: an unknown or empty one must fail at
# start, never serve without the profile's headers.
for profile in launch ''; do
  if compose run --rm -T --no-deps -e MJK_PROFILE="$profile" caddy caddy validate --config /etc/caddy/Caddyfile \
    >/dev/null 2>&1; then
    echo "stack: caddy accepted MJK_PROFILE='$profile'" >&2
    exit 1
  fi
done
echo "caddy validate: an unknown or empty MJK_PROFILE fails"

# The Caddyfile that Compose mounts, as Caddy parsed it: `ssr` never sees a session, and it ignores
# headers, so no response test could catch a missing delete. Both must be in the reverse_proxy to ssr:8081.
# The upstream keep-alive (30 s, under Node's 65 s) and lb_try_duration (5 s) are timing, so they are
# checked here on every reverse_proxy to the api and ssr.
# shellcheck disable=SC2016  # the JavaScript has template literals, no shell expansion
compose run --rm -T --no-deps caddy caddy adapt --config /etc/caddy/Caddyfile |
  node -e '
    const walk = (v, out) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, out));
      else if (v && typeof v === "object") {
        if (v.handler === "reverse_proxy") out.push(v);
        Object.values(v).forEach((x) => walk(x, out));
      }
      return out;
    };
    const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const ssr = walk(config, []).filter((h) => (h.upstreams ?? []).some((u) => u.dial === "ssr:8081"));
    if (ssr.length !== 1) throw new Error(`caddy adapt: ${ssr.length} reverse_proxy handlers to ssr:8081, expected 1`);
    const deleted = (ssr[0].headers?.request?.delete ?? []).map((h) => h.toLowerCase());
    for (const h of ["cookie", "authorization"])
      if (!deleted.includes(h)) throw new Error(`caddy adapt: the reverse_proxy to ssr:8081 does not delete ${h}`);
    console.log("caddy adapt: the reverse_proxy to ssr:8081 deletes Cookie and Authorization");
    const proxies = walk(config, []);
    if (proxies.length !== 3) throw new Error(`caddy adapt: ${proxies.length} reverse_proxy handlers, expected 3`);
    for (const p of proxies) {
      const to = (p.upstreams ?? []).map((u) => u.dial).join(",");
      if (p.transport?.keep_alive?.idle_timeout !== 30e9) throw new Error(`caddy adapt: ${to} keep-alive is not 30 s`);
      if (p.load_balancing?.try_duration !== 5e9) throw new Error(`caddy adapt: ${to} lb_try_duration is not 5 s`);
    }
    console.log("caddy adapt: every reverse_proxy keeps idle upstream connections 30 s and retries 5 s");
  '

compose up -d --wait api worker media mailsink ssr caddy edge

playwright() {
  write_guard
  docker run --rm --init --ipc=host --network mjk-e2e_default --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI -e E2E_BASE_URL=https://mjk.test -e E2E_MAIL_URL=http://mailsink:8025 \
    -e E2E_INVITE -e E2E_ACCESS_JWT_CHROMIUM -e E2E_ACCESS_JWT_WEBKIT \
    -v "$PWD:/work" -w /work/apps/web "$PLAYWRIGHT_IMAGE" \
    node_modules/.bin/playwright test -c e2e/playwright.config.ts "$@"
}

playwright --grep-invert '@ssr-down|@load|@photos' --pass-with-no-tests "$@"

# P3b: photo-upload.spec.ts signs three members a test engine in by mailed code. With the main pass's own sign-ins
# that passes code_prefix's 20 an hour from the one Playwright address, so the photo pass starts with the three code
# buckets emptied (test rows only; the limiter is unchanged). It runs before the log scans and media's restart and
# OOM check below, so both cover it.
compose exec -T db psql -U postgres -d mjk -q -v ON_ERROR_STOP=1 \
  -c "DELETE FROM rate_limit WHERE bucket IN ('code_prefix', 'code_email_prefix', 'code_email_day')"
playwright --grep @photos --pass-with-no-tests "$@"

# A§15.3 "never logged": near-me.spec.ts presses the button at 52.37312, 4.89351 (rounded 52.373, 4.894). Neither the
# raw nor the rounded position, nor a lat or lon query, is in the api's, ssr's or caddy's log. A number that merely
# contains the digits (14.894, a duration) is not a hit: the character before it must not be a digit or a dot.
# pino's ISO `"time"` is dropped first: a line logged at hh:mm:52.373 is not the position (seen in CI, P2c).
for service in api ssr caddy; do
  service_log=$(compose logs --no-color --no-log-prefix "$service" | sed -E 's/"time":"[^"]*"//g')
  if grep -qE '52\.37312|4\.89351|(^|[^0-9.])(52\.373|4\.894)|[?&](lat|lon)=' <<<"$service_log"; then
    echo "stack: the $service log holds the near-me position" >&2
    exit 1
  fi
done
echo "logs: no near-me position in the api, ssr and caddy logs"

# Invariant 8: the specs signed up and in with owner-*@mjk.test and e2e-*@mjk.test, a password ('e2e staple seven horses',
# auth.spec.ts), the invite, the owners' Access JWTs and the codes in the sink. None of them is in any log. The
# codes are read back from the sink, and there must be some, or the check proves nothing. Called after each pass
# that sends them.
mail_codes() {
  compose exec -T mailsink node -e 'fetch("http://127.0.0.1:8025/messages").then((r) => r.json()).then((ms) => console.log(ms.map((m) => m.text).join("\n")))' |
    grep -oE '\b[0-9]{6}\b' | sort -u || true
}
check_auth_logs() {
  local codes service service_log needle
  codes=$(mail_codes)
  [[ -n $codes ]] || { echo "stack: the mail sink holds no code" >&2; exit 1; }
  for service in api worker media ssr caddy db mailsink; do
    service_log=$(compose logs --no-color --no-log-prefix "$service")
    for needle in @mjk.test 'e2e staple seven horses' "${E2E_ACCESS_JWT_CHROMIUM##*.}" "${E2E_ACCESS_JWT_WEBKIT##*.}" "$E2E_INVITE"; do
      if grep -qF -- "$needle" <<<"$service_log"; then
        echo "stack: the $service log holds a spec's address, password, invite or JWT signature" >&2
        exit 1
      fi
    done
    while read -r needle; do
      if grep -qwF -- "$needle" <<<"$service_log"; then
        echo "stack: the $service log holds a sign-in code" >&2
        exit 1
      fi
    done <<<"$codes"
  done
}
check_auth_logs
echo "logs: no address, password, invite, JWT signature or code in the api, worker, media, ssr, caddy, db and mailsink logs"

# A§17.2 (P3b criterion 3): the photos of the main pass must not restart or OOM-kill the media role.
media_id=$(compose ps -q media)
read -r status restarts oom_killed < <(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$media_id")
[[ "$status $restarts $oom_killed" == 'running 0 false' ]] ||
  { echo "stack: media is $status, restarted ($restarts) or was OOM-killed ($oom_killed)" >&2; exit 1; }
grep -qx 'oom_kill 0' < <(docker exec "$media_id" cat /sys/fs/cgroup/memory.events) ||
  { echo "stack: the media role's cgroup logged an OOM kill" >&2; exit 1; }
peak=$(docker exec "$media_id" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unavailable)
echo "media: restarted 0 times, no OOM kill, memory.peak $peak bytes (limit 768 MB)"
compose run --rm -T --no-deps probe node deploy/e2e/caddy-cases.mjs real

compose stop ssr
playwright --grep @ssr-down --pass-with-no-tests "$@"

# A§17.2: 50 parallel password sign-ins (Chromium only; most answer 429) must not restart, OOM-kill or
# push the api past its 384 MB. Before the Caddy cases, which replace the api with an echo server.
playwright --project chromium --grep @load --pass-with-no-tests "$@"
api_id=$(compose ps -q api)
read -r restarts oom_killed < <(docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}}' "$api_id")
[[ "$restarts $oom_killed" == '0 false' ]] || { echo "stack: the api restarted ($restarts) or was OOM-killed ($oom_killed)" >&2; exit 1; }
grep -qx 'oom_kill 0' < <(docker exec "$api_id" cat /sys/fs/cgroup/memory.events) ||
  { echo "stack: the api's cgroup logged an OOM kill" >&2; exit 1; }
peak=$(docker exec "$api_id" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unavailable)
echo "load: the api restarted 0 times, no OOM kill, memory.peak $peak bytes (limit 384 MB)"
check_auth_logs

# The Caddy cases against the echo upstreams (caddy recreated with its log at DEBUG), then with them
# stopped (the 502s after lb_try_duration).
cases() { compose -f deploy/e2e/caddy-cases.yaml "$@"; }
cases up -d --wait api ssr caddy
cases run --rm -T --no-deps probe node deploy/e2e/caddy-cases.mjs echo
cases stop api ssr
cases run --rm -T --no-deps probe node deploy/e2e/caddy-cases.mjs down

# A§17.7, invariant 8: even at DEBUG, Caddy logged the proxied requests and the 502s without a client
# address (the probe's or a forged one), URI, query or request field. The marker is the query of every
# down case (caddy-cases.mjs MARKER).
caddy_log=$(compose logs --no-color --no-log-prefix caddy)
grep -q '"logger":"http.log.error"' <<<"$caddy_log" || { echo "stack: caddy logged no error for the 502s" >&2; exit 1; }
grep -q '"logger":"http.handlers.reverse_proxy"' <<<"$caddy_log" ||
  { echo "stack: caddy logged no proxied request" >&2; exit 1; }
# The admin SPA's route (`rewrite * /admin.html`, deploy/web/Caddyfile) logs its constant target at DEBUG, as
# "uri":"/admin.html": not a request URI. That exact line is set aside; any other "uri", a query included, fails.
caddy_log=$(grep -vF '"msg":"rewrote request","method":"GET","uri":"/admin.html"}' <<<"$caddy_log")
for needle in mjk-probe-marker-7f3a 10.63.2.20 10.63.6.20 203.0.113. '"request"' '"uri"' remote_ip client_ip; do
  if grep -qF -- "$needle" <<<"$caddy_log"; then
    echo "stack: caddy's log holds $needle" >&2
    exit 1
  fi
done
echo "caddy log: errors without the request, a client address or a query"
