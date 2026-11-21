#!/usr/bin/env bash
# The CI e2e stack (A§18): db, migrate, seed, api, ssr, caddy and a TLS edge, then Playwright in the
# pinned image on the stack's network, then again with `ssr` stopped (the @ssr-down specs: a 502).
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

# The Caddyfile that Compose mounts, as Caddy parsed it: `ssr` never sees a session, and it ignores
# headers, so no response test could catch a missing delete. Both must be in the reverse_proxy to ssr:8081.
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
  '

compose up -d --wait api ssr caddy edge

playwright() {
  docker run --rm --init --ipc=host --network mjk-e2e_default --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI -e E2E_BASE_URL=https://mjk.test \
    -v "$PWD:/work" -w /work/apps/web "$PLAYWRIGHT_IMAGE" \
    node_modules/.bin/playwright test -c e2e/playwright.config.ts "$@"
}

playwright --grep-invert @ssr-down "$@"

compose stop ssr
playwright --grep @ssr-down --pass-with-no-tests "$@"
