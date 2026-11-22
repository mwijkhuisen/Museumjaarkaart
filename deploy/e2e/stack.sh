#!/usr/bin/env bash
# The CI e2e stack (A§18): db, migrate, seed, api, ssr, caddy and a TLS edge, then Playwright in the
# pinned image on the stack's network, then again with `ssr` stopped (the @ssr-down specs: a 502). Then
# the Caddy cases (deploy/e2e/caddy-cases.mjs, p1e criteria 3 and 4): against the real api and ssr, then
# with both replaced by an echo server (caddy-cases.yaml), then with the echo servers stopped, and last
# Caddy's own log, which must hold no client address, URI or query.
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
for name in postgres mjk_migrator mjk_api mjk_ssr mjk_worker mjk_backup; do
  head -c 24 /dev/urandom | base64 | tr '+/' '-_' >"$E2E_SECRETS/db_$name"
  chmod 0444 "$E2E_SECRETS/db_$name"
done

compose() { docker compose -p mjk-e2e -f deploy/e2e/compose.yaml "$@"; }

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0)); then compose logs --no-color --tail 200 >&2 || true; fi
  compose down -v --remove-orphans >&2 || true
  rm -rf "$E2E_SECRETS"
  exit "$rc"
}
trap cleanup EXIT

compose up -d --wait db
compose run --rm migrate
compose run --rm seed

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

compose up -d --wait api ssr caddy edge

playwright() {
  docker run --rm --init --ipc=host --network mjk-e2e_default --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI -e E2E_BASE_URL=https://mjk.test \
    -v "$PWD:/work" -w /work/apps/web "$PLAYWRIGHT_IMAGE" \
    node_modules/.bin/playwright test -c e2e/playwright.config.ts "$@"
}

playwright --grep-invert @ssr-down "$@"
compose run --rm -T --no-deps probe node deploy/e2e/caddy-cases.mjs real

compose stop ssr
playwright --grep @ssr-down --pass-with-no-tests "$@"

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
for needle in mjk-probe-marker-7f3a 10.63.2.20 10.63.6.20 203.0.113. '"request"' '"uri"' remote_ip client_ip; do
  if grep -qF -- "$needle" <<<"$caddy_log"; then
    echo "stack: caddy's log holds $needle" >&2
    exit 1
  fi
done
echo "caddy log: errors without the request, a client address or a query"
