#!/usr/bin/env bash
# deploy/tests/e2e.sh (P1e criteria 2, 6, 7, 8; job `ci / deploy`): the host scripts and the production
# compose stack end to end, on a throw-away Docker host. Run as root:
#   sudo deploy/tests/e2e.sh
# It builds nothing unless an image is missing: it uses the local images mjk-server:e2e, mjk-web:e2e and
# mjk-backup:e2e (override with MJK_E2E_SERVER_IMAGE, MJK_E2E_WEB_IMAGE, MJK_E2E_BACKUP_IMAGE) and builds
# any that is absent from deploy/{server,web}/Dockerfile (MJK_E2E_BUILD_ARGS adds `docker build` options,
# for example `--build-context <a FROM ref>=docker-image://<a mirror of the same digest>` in a sandbox).
#
# Everything lives under a throw-away root (MJK_ROOT, a mktemp directory): the scripts keep their
# production paths as defaults and only this test sets MJK_ROOT, which moves every host path below it
# (the compose copy's bind mounts and secret files included), skips systemctl and lets the test fake the
# stand-ins. It never reads or writes the host's /etc/mjk, /srv/mjk, /etc/rws, /srv/rws, /etc/f1 or
# /srv/f1, and it refuses to start where a compose project `mjk`, one of the eight mjk-* networks, the
# volume mjk_pgdata or `table inet mjk` already exists (a real install, or another run).
#
# Steps (each prints "e2e: ok: ..." or fails the run):
#   1. mjk-install: refuses to enable anything while the secrets are missing and names them (names only);
#      makes the root-only lock directory run/mjk and its tmpfiles entry, never touches the host's /run/lock;
#      refuses an mjk.env with a key outside the allowlist or a loose mode;
#      with the secrets and mjk.env made by the test it installs; a second run changes nothing (a listing
#      with owners, modes and checksums before and after); it refuses an overlapping subnet and a path that
#      resolves into /srv/f1.
#   2. table inet mjk loaded from the installed /etc/mjk/mjk.nft in the host's network namespace (the
#      real boundary), mjk-resolvers filled, and mjk-egress filled worker_dst4 from the test's own
#      etc/mjk/egress-hosts (one literal address, so the host never looks up an outside name; it replaces
#      the installed list after step 1). Then the test's own `table inet mjk_e2e_sink`, which
#      drops every packet that leaves an mjk-* bridge for another interface after table inet mjk has
#      judged it: no packet from a container reaches a host outside this machine (invariant 9: no R2,
#      Cloudflare, healthchecks.io, Wikidata or RCE), and a probe that table inet mjk lets through is
#      counted there. Container DNS is the exception the sink cannot see: Docker's embedded DNS asks the
#      runner's resolver from the host's namespace (step 4), so a container in this run may only ever
#      look up reserved `.invalid` names (step 4's control, step 7's backup endpoint).
#      Where the sandbox does not allow loading a table, the steps that need it are skipped with a
#      message: a skip is a failure under CI.
#   3. deploy: mjk-update --server --web --backup on a pseudo-terminal (as an owner's manual run, so a
#      compose step that reads the terminal hangs here), with the local images and a stand-in for cloudflared at
#      10.63.6.10 (a compose override beside the installed compose file): every daemon healthy, current.env
#      holds the three refs and the compose sha256, the site answers on 127.0.0.1:8280 and through the
#      tunnel network, only 127.0.0.1:8280 is published, a second run is "up to date", a held lock makes it
#      exit 0; a compose file whose secret file is missing is refused (78, stack untouched); a changed
#      compose file alone is deployed, and a deploy removes our old image references
#      (ghcr.io/mwijkhuisen/mjk-*) and nothing else. The worker gets an unusable ping key (it pings nothing).
#   4. egress probes through the real table (throw-away busybox containers on the stack's own networks):
#      each probe must raise exactly the expected drop counter; the allowed ones raise none of table inet
#      mjk's and are then counted, and dropped, by the sink. Then Docker's embedded DNS, which the table
#      does not see: caddy and ssr get SERVFAIL for an outside name, caddy still resolves api and ssr.
#   5. rollback: a server image whose daemons never get healthy (migrate and healthcheck are the real
#      ones): mjk-update exits 1, current.env is unchanged, failed.env names the broken image, the old
#      images are healthy again and the site answers.
#   6. mjk-tick: reloads a deleted table and refills resolvers4 and worker_dst4, writes the disk file, restarts an
#      unhealthy container while a backup holds the lock shared, writes the disk file while a deploy holds
#      it or when the lock directory is unusable (then exit 1, and mjk-update refuses), and fails closed (stack stopped, firewall-stopped written) when the table cannot be loaded, then
#      starts the stack again once it can.
#   7. the backup unit's command line runs under the shared lock against an R2 endpoint that cannot
#      resolve (https://backup.invalid), and mjk-ping sends the key on stdin only (never in the process
#      table) to the right paths of a local stand-in.
#   8. teardown: the stack, networks, volume, table, groups and files this run made are removed.
set -euo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
NETS=(mjk-db mjk-edge mjk-egress mjk-api-egress mjk-tunnel mjk-tunnel-edge mjk-publish mjk-backup-egress)

SERVER_IMAGE=${MJK_E2E_SERVER_IMAGE:-mjk-server:e2e}
WEB_IMAGE=${MJK_E2E_WEB_IMAGE:-mjk-web:e2e}
BACKUP_IMAGE=${MJK_E2E_BACKUP_IMAGE:-mjk-backup:e2e}
BROKEN_IMAGE=mjk-server:e2e-broken
# The cloudflared stand-in, the egress probes and the unhealthy-container test (test-only image).
STANDIN_IMAGE=busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
DOMAIN=mjk.test
# The probes' public destination: outside private4, cf4 and cf_tunnel4, so table inet mjk judges it as
# "the internet". No packet reaches it: what table inet mjk lets through, the sink drops (step 2).
PROBE_IP=9.9.9.9
# The test's one worker_dst4 address: outside private4, cf4 and cf_tunnel4 too, and dropped by the sink.
WORKER_DST_IP=149.112.112.112
# The documentation resolver of the test's resolv.conf (in resolvers4; also dropped by the sink).
TEST_RESOLVER=192.0.2.53
OLD_REF=ghcr.io/mwijkhuisen/mjk-server:e2e-old

fail() {
  echo "e2e: FAIL: $1" >&2
  exit 1
}
ok() { echo "e2e: ok: $1"; }
skip() {
  if [[ -n ${CI:-} ]]; then fail "$1 (a skip is a failure under CI)"; fi
  echo "e2e: SKIP: $1" >&2
}
step() { echo "e2e: --- $1"; }
indent() { sed 's/^/    /'; }

[[ $EUID -eq 0 ]] || fail "run as root (sudo deploy/tests/e2e.sh)"
for cmd in docker jq curl flock python3 sha256sum script; do command -v "$cmd" >/dev/null || fail "$cmd is required"; done
docker compose version >/dev/null 2>&1 || fail "docker compose is required"

# --- preflight: never on a host that has an mjk stack ------------------------------------------------
[[ -z $(docker ps -a -q --filter label=com.docker.compose.project=mjk) ]] || fail "a compose project mjk exists here; run this on a throw-away host"
for net in "${NETS[@]}"; do
  if docker network inspect "$net" >/dev/null 2>&1; then fail "the Docker network $net exists here; run this on a throw-away host"; fi
done
for vol in mjk_pgdata mjk_media_work; do
  if docker volume inspect "$vol" >/dev/null 2>&1; then fail "the volume $vol exists here; run this on a throw-away host"; fi
done
if command -v nft >/dev/null && nft list table inet mjk >/dev/null 2>&1; then
  fail "table inet mjk is loaded here; run this on a throw-away host"
fi
if command -v nft >/dev/null && nft list table inet mjk_e2e_sink >/dev/null 2>&1; then
  fail "table inet mjk_e2e_sink is loaded here (another run?)"
fi

# --- state to undo -----------------------------------------------------------------------------------
TESTROOT=$(mktemp -d "${TMPDIR:-/tmp}/mjk-e2e.XXXXXX")
TESTROOT2=$(mktemp -d "${TMPDIR:-/tmp}/mjk-e2e-refuse.XXXXXX")
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/mjk-e2e-scratch.XXXXXX")
chmod 0755 "$TESTROOT" "$TESTROOT2" "$SCRATCH"
NFT_LOADED=0
SINK_LOADED=0
BUILT_IMAGES=()
PING_PID=
declare -a GROUPS_BEFORE=()
mapfile -t GROUPS_BEFORE < <(getent group | awk -F: '$3 >= 63001 && $3 <= 63013 {print $1}')

export MJK_ROOT=$TESTROOT
ETC=$TESTROOT/etc/mjk
SRVD=$TESTROOT/srv/mjk
STATE=$SRVD/state
BIN=$TESTROOT/usr/local/bin

dc() { docker compose -p mjk -f "$ETC/compose.yaml" -f "$ETC/compose.override.yaml" --env-file "$STATE/current.env" "$@"; }

cleanup() {
  local rc=$?
  trap - EXIT
  set +e
  [[ -z $PING_PID ]] || kill "$PING_PID" 2>/dev/null
  if ((rc != 0)); then
    docker ps -a --filter label=com.docker.compose.project=mjk --format 'e2e: container {{.Names}} {{.Status}}' >&2
  fi
  # The stack, whatever state it is in: by label, then the networks and the volumes by name.
  docker ps -a -q --filter label=com.docker.compose.project=mjk | xargs -r docker rm -f -v >/dev/null 2>&1
  docker rm -f mjk-e2e-stray >/dev/null 2>&1
  for net in "${NETS[@]}" mjk-e2e-overlap; do
    # Only our own: the label of the compose project mjk, or the overlap network of this run.
    if [[ $net == mjk-e2e-overlap || $(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$net" 2>/dev/null) == mjk ]]; then
      docker network rm "$net" >/dev/null 2>&1
    fi
  done
  docker volume rm mjk_pgdata mjk_media_work >/dev/null 2>&1
  if ((NFT_LOADED)); then nft delete table inet mjk >/dev/null 2>&1; fi
  if ((SINK_LOADED)); then nft delete table inet mjk_e2e_sink >/dev/null 2>&1; fi
  local g
  while read -r g; do
    # Only groups this run created.
    [[ " ${GROUPS_BEFORE[*]} " == *" $g "* ]] || groupdel "$g" >/dev/null 2>&1
  done < <(getent group | awk -F: '$3 >= 63001 && $3 <= 63013 {print $1}')
  for image in "${BUILT_IMAGES[@]}" "$BROKEN_IMAGE" "$OLD_REF"; do docker rmi "$image" >/dev/null 2>&1; done
  rm -rf "$TESTROOT" "$TESTROOT2" "$SCRATCH"
  exit "$rc"
}
trap cleanup EXIT

# One listing of a tree: path, type, mode, owner, group, size, mtime, link target, and a checksum per file.
snapshot() {
  (
    cd "$1"
    find . -printf '%p %y %m %u:%g %s %T@ %l\n' | sort
    find . -type f -exec sha256sum {} + | sort -k2
  )
}

# The packets of the egress chain's drop rule whose comment starts with $1.
drop_packets() {
  nft -j list chain inet mjk egress | jq -r --arg c "$1" \
    '[.nftables[] | select(.rule) | .rule | select((.comment // "") | startswith($c)) | [.expr[] | select(.counter) | .counter.packets] | first] | first // empty'
}

# The packets the sink counted for the probes' two destinations.
sink_packets() {
  nft -j list chain inet mjk_e2e_sink forward | jq -r \
    '[.nftables[] | select(.rule) | .rule | select((.comment // "") == "e2e sink: a probe") | [.expr[] | select(.counter) | .counter.packets] | first] | first // empty'
}

run_update() { "$BIN/mjk-update" "$@"; }
# On a pseudo-terminal with job control, as from an owner's shell (util-linux script); bounded, because a
# compose step that reads the terminal stops there.
run_update_tty() {
  timeout -k 10 600 script -qec "$(printf '%q ' "$BIN/mjk-update" "$@")" /dev/null </dev/null | tr -d '\r'
}

# --- images ------------------------------------------------------------------------------------------
REVISION=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)
[[ $REVISION =~ ^[0-9a-f]{40}$ ]] || REVISION=$(printf '0%.0s' {1..40})
build_args=()
[[ -z ${MJK_E2E_BUILD_ARGS:-} ]] || read -r -a build_args <<<"$MJK_E2E_BUILD_ARGS"
if ! docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1; then
  step "building $SERVER_IMAGE"
  docker build -q -f "$REPO/deploy/server/Dockerfile" --target server --build-arg "REVISION=$REVISION" "${build_args[@]}" -t "$SERVER_IMAGE" "$REPO" >/dev/null
  BUILT_IMAGES+=("$SERVER_IMAGE")
fi
if ! docker image inspect "$BACKUP_IMAGE" >/dev/null 2>&1; then
  step "building $BACKUP_IMAGE"
  docker build -q -f "$REPO/deploy/server/Dockerfile" --target backup --build-arg "REVISION=$REVISION" "${build_args[@]}" -t "$BACKUP_IMAGE" "$REPO" >/dev/null
  BUILT_IMAGES+=("$BACKUP_IMAGE")
fi
if ! docker image inspect "$WEB_IMAGE" >/dev/null 2>&1; then
  step "building $WEB_IMAGE"
  docker build -q -f "$REPO/deploy/web/Dockerfile" --build-arg "REVISION=$REVISION" "${build_args[@]}" -t "$WEB_IMAGE" "$REPO" >/dev/null
  BUILT_IMAGES+=("$WEB_IMAGE")
fi
[[ -n $(docker image inspect -f "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$SERVER_IMAGE") ]] ||
  fail "$SERVER_IMAGE has no revision label"

probe() { # <network> <private|final|none> <command...>: runs it, compares the drop counters
  local net=$1 expect=$2 priv0 final0 priv1 final1 sink0 sink1
  shift 2
  priv0=$(drop_packets 'private, link-local')
  final0=$(drop_packets 'everything else')
  sink0=$(sink_packets)
  local rc=0
  docker run --rm --network "$net" --user 63532:63532 --read-only --cap-drop ALL --security-opt no-new-privileges \
    "$STANDIN_IMAGE" "$@" >/dev/null 2>&1 || rc=$?
  ((rc < 125)) || fail "$net $*: docker could not run the probe (exit $rc)"
  priv1=$(drop_packets 'private, link-local')
  final1=$(drop_packets 'everything else')
  sink1=$(sink_packets)
  case $expect in
    private) ((priv1 > priv0 && final1 == final0)) || fail "$net $*: expected the private-range drop (private $priv0->$priv1, final $final0->$final1)" ;;
    final) ((final1 > final0 && priv1 == priv0)) || fail "$net $*: expected the final drop (private $priv0->$priv1, final $final0->$final1)" ;;
    none) ((final1 == final0 && priv1 == priv0 && sink1 > sink0)) ||
      fail "$net $*: expected no drop in table inet mjk and the packet at the sink (private $priv0->$priv1, final $final0->$final1, sink $sink0->$sink1)" ;;
  esac
}

# --- 1. mjk-install ----------------------------------------------------------------------------------
step "1. mjk-install"
# The host's /run/lock is shared (1777 on Debian): no run of mjk-install may change it (P1e review S2).
RUNLOCK_BEFORE=$(stat -c '%u:%g:%a' /run/lock 2>/dev/null || echo absent)
install_out=$("$REPO/deploy/bin/mjk-install") || fail "the first mjk-install failed"
grep -q 'NOT ENABLED' <<<"$install_out" || fail "mjk-install did not say that the timers stay off without secrets"
for name in db_postgres db_mjk_migrator db_mjk_api db_mjk_ssr db_mjk_worker db_mjk_backup cf_tunnel_token r2_backup_put restic_password hc_ping_key r2_media_rw app_keys lettermint_api_token; do
  grep -q "secret $name: missing" <<<"$install_out" || fail "mjk-install did not name the missing secret $name"
done
grep -q 'mjk.env: missing' <<<"$install_out" || fail "mjk-install did not name the missing mjk.env"
ok "without secrets mjk-install installs, names each missing secret and mjk.env, and leaves the timers off"

# The secrets of the test: random, root:<gid> 0440 (never a real one). Names and GIDs as A§17.3.
declare -A SECRET_GID=(
  [db_postgres]=63001 [db_mjk_migrator]=63002 [db_mjk_api]=63003 [db_mjk_ssr]=63004 [db_mjk_worker]=63005
  [db_mjk_backup]=63006 [cf_tunnel_token]=63007 [r2_backup_put]=63010 [restic_password]=63011 [hc_ping_key]=63013
  [r2_media_rw]=63009 [app_keys]=63012 [lettermint_api_token]=63008
)
for name in "${!SECRET_GID[@]}"; do
  case $name in
    db_*) head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$ETC/secrets/$name" ;;
    # The api, worker and admin exit 78 on an invalid app_keys: four key=value lines, each value 32 random
    # bytes in base64url without padding (43 characters).
    app_keys)
      for key in otp_pepper invite_pepper code_seal altcha_hmac; do
        printf '%s=%s\n' "$key" "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
      done >"$ETC/secrets/$name"
      ;;
    hc_ping_key) printf 'e2ePingKey%s' "$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" >"$ETC/secrets/$name" ;;
    *) head -c 24 /dev/urandom | base64 | tr -d '\n' >"$ETC/secrets/$name" ;;
  esac
  chown "0:${SECRET_GID[$name]}" "$ETC/secrets/$name"
  chmod 0440 "$ETC/secrets/$name"
done
cat >"$ETC/mjk.env" <<EOF
MJK_BRAND_NAME=MjkE2E
MJK_DOMAIN=$DOMAIN
MJK_PROFILE=prelaunch
MJK_SYNC_CONTACT=ops@$DOMAIN
CF_ACCESS_TEAM=test-team
CF_ACCESS_AUD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MJK_CONTROLLER_NAME=E2EController
MJK_CONTACT_EMAIL=privacy@$DOMAIN
MJK_R2_ENDPOINT=https://backup.invalid
MJK_R2_BUCKET_BACKUP=mjk-backup
MJK_R2_BUCKET_MEDIA=mjk-media
EOF
chmod 0644 "$ETC/mjk.env"
# The test's own resolv.conf for mjk-tick (a documentation address: never contacted).
printf 'nameserver 192.0.2.53\n' >"$TESTROOT/etc/resolv.conf"

# The cloudflared stand-in: the same service (hardening, networks, fixed address 10.63.6.10), another image.
# The worker's hc_ping_key is a file the worker rejects (a space is outside the key's alphabet), so its
# pinger is off and it never calls healthchecks.io; mjk-ping (step 7) keeps the real test key.
printf 'not a ping key\n' >"$ETC/e2e-worker-hc_ping_key"
chown 0:63013 "$ETC/e2e-worker-hc_ping_key"
chmod 0440 "$ETC/e2e-worker-hc_ping_key"
cat >"$ETC/compose.override.yaml" <<EOF
services:
  cloudflared:
    image: $STANDIN_IMAGE
    init: true
    command: !override ["sleep", "86400"]
    healthcheck:
      test: !override ["CMD", "true"]
secrets:
  hc_ping_key:
    file: $ETC/e2e-worker-hc_ping_key
EOF
chmod 0644 "$ETC/compose.override.yaml"

install_out=$("$REPO/deploy/bin/mjk-install") || fail "mjk-install with the secrets failed"
if grep -q 'NOT ENABLED' <<<"$install_out"; then fail "mjk-install still lists something missing: $install_out"; fi
for name in mjk-update mjk-tick mjk-resolvers mjk-egress mjk-ping mjk-envcheck; do
  [[ $(stat -c '%u:%g:%a' "$BIN/$name") == 0:0:755 ]] || fail "$BIN/$name is not root:root 0755"
done
[[ $(stat -c '%u:%g:%a' "$ETC/egress-hosts") == 0:0:644 ]] || fail "$ETC/egress-hosts is not root:root 0644"
cmp -s "$REPO/deploy/host/egress-hosts" "$ETC/egress-hosts" || fail "$ETC/egress-hosts is not a copy of deploy/host/egress-hosts"
[[ $(stat -c '%u:%g:%a' "$ETC/secrets") == 0:0:700 ]] || fail "$ETC/secrets is not root:root 0700"
# media-work is a tmpfs volume since the P3b review (M3), not a host directory: mjk-install no longer makes it.
[[ ! -e $SRVD/media-work ]] || fail "mjk-install made $SRVD/media-work"
for dir in originals quarantine exports tiles-build backup-staging; do
  [[ $(stat -c '%u:%g:%a' "$SRVD/$dir") == 63532:63532:700 ]] || fail "$SRVD/$dir is not 63532:63532 0700"
done
[[ $(stat -c '%u:%g:%a' "$TESTROOT/run/mjk") == 0:0:700 ]] || fail "the lock directory run/mjk is not root:root 0700"
grep -qx 'd /run/mjk 0700 root root -' "$TESTROOT/etc/tmpfiles.d/mjk.conf" || fail "the tmpfiles entry for /run/mjk is not installed"
[[ ! -e $TESTROOT/run/lock ]] || fail "mjk-install made a run/lock in the test root"
ok "with the thirteen secrets and mjk.env mjk-install is satisfied; scripts root:root 0755, egress-hosts 0644, secrets/ 0700, the data directories 63532 0700, the lock directory root 0700 with its tmpfiles entry"

snapshot "$TESTROOT" >"$SCRATCH/before.txt"
groups_before=$(getent group | sort)
second_out=$("$REPO/deploy/bin/mjk-install") || fail "the second mjk-install failed"
snapshot "$TESTROOT" >"$SCRATCH/after.txt"
diff -u "$SCRATCH/before.txt" "$SCRATCH/after.txt" >&2 || fail "a second mjk-install changed the tree"
[[ $groups_before == "$(getent group | sort)" ]] || fail "a second mjk-install changed the groups"
grep -q 'no changes' <<<"$second_out" || fail "the second mjk-install did not report 'no changes': $second_out"
ok "a second mjk-install changes nothing (tree listing with owners, modes, sizes, mtimes and checksums, and the group database, identical)"

# Refusals, each before any change.
docker network create --subnet 10.63.3.128/25 mjk-e2e-overlap >/dev/null
if overlap_out=$("$REPO/deploy/bin/mjk-install" 2>&1); then fail "mjk-install ran with an overlapping Docker network"; fi
grep -q 'overlaps the Docker network mjk-e2e-overlap' <<<"$overlap_out" || fail "the overlap refusal does not name the network: $overlap_out"
docker network rm mjk-e2e-overlap >/dev/null
mkdir -p "$TESTROOT2/srv"
ln -s /srv/f1 "$TESTROOT2/srv/mjk"
if foreign_out=$(MJK_ROOT=$TESTROOT2 "$REPO/deploy/bin/mjk-install" 2>&1); then fail "mjk-install ran with /srv/mjk pointing into /srv/f1"; fi
grep -q 'REFUSED' <<<"$foreign_out" || fail "the f1 refusal is not a REFUSED line: $foreign_out"
[[ ! -e /srv/f1 ]] || [[ -z $(find /srv/f1 -newer "$SCRATCH/before.txt" -print -quit 2>/dev/null) ]] || fail "something was written under /srv/f1"
ok "mjk-install refuses a subnet that overlaps a foreign Docker network and a /srv/mjk that resolves into /srv/f1, before any change"
# The hosts list is installed like the other files: never through a symlink, never into another stack.
mv "$ETC/egress-hosts" "$SCRATCH/egress-hosts.aside"
ln -s /etc/f1/egress-hosts "$ETC/egress-hosts"
if hosts_out=$("$REPO/deploy/bin/mjk-install" 2>&1); then fail "mjk-install wrote through a symlinked egress-hosts"; fi
grep -q 'REFUSED' <<<"$hosts_out" || fail "the egress-hosts refusal is not a REFUSED line: $hosts_out"
rm "$ETC/egress-hosts"
mv "$SCRATCH/egress-hosts.aside" "$ETC/egress-hosts"
ok "mjk-install refuses an egress-hosts that is a symlink into /etc/f1"
# mjk.env: an unknown key (DATABASE_URL, NODE_OPTIONS) or a loose mode is refused, without the value.
cp -p "$ETC/mjk.env" "$SCRATCH/mjk.env.good"
for extra in 'DATABASE_URL=postgres://e2e-not-a-real-login@db/mjk' 'NODE_OPTIONS=--require=/tmp/e2e.js' 'MJK_SECRET_FILE=/tmp/x'; do
  printf '%s\n' "$extra" >>"$ETC/mjk.env"
  if env_out=$("$REPO/deploy/bin/mjk-install" 2>&1); then fail "mjk-install accepted mjk.env with ${extra%%=*}"; fi
  grep -q "the key ${extra%%=*} is not allowed" <<<"$env_out" || fail "the mjk.env refusal does not name ${extra%%=*}: $env_out"
  if grep -qF -- "${extra#*=}" <<<"$env_out"; then fail "the mjk.env refusal printed a value"; fi
  cp -p "$SCRATCH/mjk.env.good" "$ETC/mjk.env"
done
chmod 0664 "$ETC/mjk.env"
if env_out=$("$REPO/deploy/bin/mjk-install" 2>&1); then fail "mjk-install accepted a group-writable mjk.env"; fi
grep -q 'must be root:root 0644 or 0640' <<<"$env_out" || fail "the mjk.env mode refusal: $env_out"
chmod 0644 "$ETC/mjk.env"
ok "mjk-install refuses an mjk.env with a key outside the allowlist (naming the key, never the value) or a loose mode"
[[ $(stat -c '%u:%g:%a' /run/lock 2>/dev/null || echo absent) == "$RUNLOCK_BEFORE" ]] || fail "the host's /run/lock changed ($RUNLOCK_BEFORE)"
ok "the host's /run/lock is unchanged ($RUNLOCK_BEFORE) after every mjk-install run"

# --- 2. the firewall ---------------------------------------------------------------------------------
step "2. table inet mjk"
# From here on the worker's hosts list is the test's: one literal address, never a lookup (the installed
# list names real hosts). No mjk-install runs after this point.
printf '# e2e: a literal address only\n%s\n' "$WORKER_DST_IP" >"$ETC/egress-hosts"
HAVE_NFT=0
if command -v nft >/dev/null && nft add table inet mjk_e2e_probe >/dev/null 2>&1; then
  nft delete table inet mjk_e2e_probe >/dev/null 2>&1 || true
  HAVE_NFT=1
fi
if ((HAVE_NFT)); then
  nft -c -f "$ETC/mjk.nft" || fail "nft -c refuses the installed mjk.nft"
  nft -f "$ETC/mjk.nft" || fail "nft cannot load the installed mjk.nft"
  NFT_LOADED=1
  "$BIN/mjk-resolvers" "$TESTROOT/etc/resolv.conf" >/dev/null || fail "mjk-resolvers could not fill resolvers4"
  nft list set inet mjk resolvers4 | grep -q '192.0.2.53' || fail "resolvers4 does not hold the test resolver"
  "$BIN/mjk-egress" >/dev/null || fail "mjk-egress could not fill worker_dst4"
  nft list set inet mjk worker_dst4 | grep -qF "$WORKER_DST_IP" || fail "worker_dst4 does not hold the test address"
  ok "the installed mjk.nft loads in the host's network namespace; mjk-resolvers fills resolvers4, mjk-egress worker_dst4"
  # After table inet mjk (priority filter - 10) and before Docker's chains: whatever table inet mjk
  # accepts on its way out of an mjk-* bridge ends here, counted. Traffic between two mjk bridges passes.
  nft -f - <<EOF || fail "could not load table inet mjk_e2e_sink"
table inet mjk_e2e_sink {
	chain forward {
		type filter hook forward priority filter - 5; policy accept;
		iifname "mjk-*" oifname "mjk-*" accept
		iifname "mjk-*" ip daddr { $PROBE_IP, $WORKER_DST_IP, $TEST_RESOLVER } counter drop comment "e2e sink: a probe"
		iifname "mjk-*" counter drop comment "e2e sink: everything else"
	}
}
EOF
  SINK_LOADED=1
  ok "table inet mjk_e2e_sink drops every packet that table inet mjk lets out of an mjk-* bridge"
else
  skip "the host's nftables does not allow loading a table here: the egress probes and mjk-tick's table steps are not run (nft-check.sh covers the load in a namespace)"
  # The deploy steps only need the answer "the table is there".
  printf '#!/bin/sh\nexit 0\n' >"$SCRATCH/fake-nft"
  chmod 0755 "$SCRATCH/fake-nft"
  export MJK_NFT=$SCRATCH/fake-nft
fi

# --- 3. deploy ---------------------------------------------------------------------------------------
step "3. deploy with mjk-update"
if ! deploy_out=$(run_update_tty --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1); then
  echo "$deploy_out" >&2
  fail "the first mjk-update failed"
fi
indent <<<"$deploy_out"
[[ -f $STATE/current.env ]] || fail "no current.env after a deploy"
compose_sha() { cat "$ETC/compose.yaml" "$ETC/compose.override.yaml" | sha256sum | cut -d ' ' -f 1; }
for line in "MJK_SERVER_IMAGE=$SERVER_IMAGE" "MJK_WEB_IMAGE=$WEB_IMAGE" "MJK_BACKUP_IMAGE=$BACKUP_IMAGE" "MJK_COMPOSE_SHA256=$(compose_sha)"; do
  grep -qx "$line" "$STATE/current.env" || fail "current.env does not hold $line"
done
[[ ! -e $STATE/failed.env ]] || fail "failed.env exists after a good deploy"
for svc in db api ssr worker media caddy cloudflared; do
  id=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter "label=com.docker.compose.service=$svc" --filter label=com.docker.compose.oneoff=False)
  [[ -n $id ]] || fail "no running container for $svc"
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$id") == healthy ]] || fail "$svc is not healthy"
done
ok "every daemon is healthy; current.env holds the three refs and the compose sha256; no failed.env"
worker_id=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.service=worker)
for _ in $(seq 1 15); do
  docker logs "$worker_id" 2>&1 | grep -qF '"msg":"healthchecks_key_invalid"' && break
  sleep 1
done
docker logs "$worker_id" 2>&1 | grep -qF '"msg":"healthchecks_key_invalid"' || fail "the worker did not reject the test's unusable ping key"
ok "the worker read its hc_ping_key secret and rejected it: its pinger is off"

[[ $(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1:8280/api/v1/healthz) == 200 ]] || fail "healthz through 127.0.0.1:8280"
[[ $(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1:8280/) == 200 ]] || fail "/ through 127.0.0.1:8280"
[[ $(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Host: other.example" http://127.0.0.1:8280/) == 421 ]] || fail "an unknown Host is not 421"
standin=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.service=cloudflared)
docker exec "$standin" wget -q -T 10 -O /dev/null --header "Host: $DOMAIN" --header 'X-Forwarded-Proto: https' http://caddy/api/v1/healthz ||
  fail "the tunnel network (stand-in at 10.63.6.10) cannot reach caddy"
[[ $(docker inspect -f '{{(index .NetworkSettings.Networks "mjk-tunnel-edge").IPAddress}}' "$standin") == 10.63.6.10 ]] || fail "the stand-in is not at 10.63.6.10"
ports=$(docker ps --filter label=com.docker.compose.project=mjk --format '{{.Ports}}' | tr ',' '\n' | grep -E '[0-9]+->' | sed 's/^ *//' | sort -u)
[[ $ports == "127.0.0.1:8280->80/tcp" ]] || fail "published ports: $ports"
ok "the site answers on 127.0.0.1:8280 (200, 421 for another Host) and through the tunnel network from 10.63.6.10; only 127.0.0.1:8280 is published"

cur_before=$(sha256sum "$STATE/current.env")
up_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || fail "the second mjk-update failed"
grep -q 'up to date' <<<"$up_out" || fail "the second mjk-update did not say up to date: $up_out"
[[ $cur_before == "$(sha256sum "$STATE/current.env")" ]] || fail "an up-to-date run changed current.env"
exec 8>"$TESTROOT/run/mjk/deploy.lock"
flock -n 8 || fail "could not take the deploy lock in the test"
busy_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || fail "mjk-update with the lock held did not exit 0"
grep -q 'busy' <<<"$busy_out" || fail "mjk-update with the lock held did not say busy: $busy_out"
exec 8>&-
exec 8>"$TESTROOT/run/mjk/deploy.lock"
flock -s -n 8 || fail "could not take the deploy lock shared in the test"
busy_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || fail "mjk-update with a shared lock held did not exit 0"
grep -q 'busy' <<<"$busy_out" || fail "mjk-update with a shared lock held (a backup) did not say busy: $busy_out"
exec 8>&-
ok "a second run is 'up to date' and leaves current.env alone; with the lock held, exclusive or shared (a backup), it exits 0 with 'busy'"

# mjk.env edited after the last install: mjk-update checks it again and refuses (78), naming the key only.
cp -p "$ETC/mjk.env" "$SCRATCH/mjk.env.deployed"
printf 'DATABASE_URL=postgres://e2e-not-a-real-login@db/mjk\n' >>"$ETC/mjk.env"
upd_rc=0
upd_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || upd_rc=$?
cp -p "$SCRATCH/mjk.env.deployed" "$ETC/mjk.env"
((upd_rc == 78)) || fail "mjk-update with DATABASE_URL in mjk.env exited $upd_rc, not 78: $upd_out"
grep -q 'the key DATABASE_URL is not allowed' <<<"$upd_out" || fail "mjk-update did not name the refused key: $upd_out"
if grep -qF 'e2e-not-a-real-login' <<<"$upd_out"; then fail "mjk-update printed the refused value"; fi
ok "mjk-update re-checks mjk.env before a deploy: a key outside the allowlist is exit 78, named without its value"

# A compose change while a secret file it names is missing (P1d's r2_media_rw on a P1e host): exit 78,
# naming the file, with current.env, failed.env and the running worker untouched.
worker_before=$(docker ps -q --no-trunc --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.service=worker)
cur_before=$(sha256sum "$STATE/current.env")
mv "$ETC/secrets/r2_media_rw" "$SCRATCH/r2_media_rw.aside"
printf '# e2e: a compose change with a secret missing\n' >>"$ETC/compose.override.yaml"
upd_rc=0
upd_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || upd_rc=$?
mv "$SCRATCH/r2_media_rw.aside" "$ETC/secrets/r2_media_rw"
((upd_rc == 78)) || fail "mjk-update with r2_media_rw missing exited $upd_rc, not 78: $upd_out"
grep -qF "secret file(s) missing: $ETC/secrets/r2_media_rw" <<<"$upd_out" || fail "mjk-update did not name the missing secret file: $upd_out"
[[ $cur_before == "$(sha256sum "$STATE/current.env")" && ! -e $STATE/failed.env ]] || fail "the refused run changed current.env or wrote failed.env"
[[ $worker_before == "$(docker ps -q --no-trunc --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.service=worker)" ]] ||
  fail "the refused run touched the worker"
ok "mjk-update refuses a compose file whose secret file is missing (exit 78, named), with the stack, current.env and failed.env untouched"

# A compose change alone is deployed with the same images; the deploy then removes our old references.
docker tag "$STANDIN_IMAGE" "$OLD_REF"
printf '# e2e: a compose change\n' >>"$ETC/compose.override.yaml"
if ! cc_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1); then
  echo "$cc_out" >&2
  fail "mjk-update after a compose change failed"
fi
indent <<<"$cc_out"
grep -q 'compose file changed since current.env' <<<"$cc_out" || fail "mjk-update did not see the compose change: $cc_out"
grep -q '^mjk-update: deployed: ' <<<"$cc_out" || fail "mjk-update did not deploy the compose change: $cc_out"
grep -qx "MJK_COMPOSE_SHA256=$(compose_sha)" "$STATE/current.env" || fail "current.env does not hold the new compose sha256"
up_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1) || fail "mjk-update after the compose deploy failed"
grep -q 'up to date' <<<"$up_out" || fail "the run after the compose deploy did not say up to date: $up_out"
ok "a changed compose file alone is deployed with the same images and recorded in current.env; the next run is up to date"
if docker image inspect "$OLD_REF" >/dev/null 2>&1; then fail "the deploy left the old reference $OLD_REF"; fi
for image in "$SERVER_IMAGE" "$WEB_IMAGE" "$BACKUP_IMAGE" "$STANDIN_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "the deploy removed $image"
done
grep -q 'old images: 1 reference(s)' <<<"$cc_out" || fail "mjk-update did not report one removed reference: $cc_out"
ok "a deploy removes an old ghcr.io/mwijkhuisen/mjk-* reference and keeps current.env's images and other images"

# --- 4. egress probes --------------------------------------------------------------------------------
step "4. egress probes through the real table"
if ((HAVE_NFT)) && awk '$2 == "00000000" && $8 == "00000000" && $1 !~ /^mjk-/ {f = 1} END {exit !f}' /proc/net/route; then
  probe mjk-egress final nc -w 2 -z "$PROBE_IP" 80
  ok "worker network: tcp/80 to a public address is dropped (the final drop)"
  probe mjk-egress private nc -w 2 -z 192.168.255.254 443
  ok "worker network: tcp/443 to a private address is dropped (the private-range drop)"
  probe mjk-egress final nc -w 2 -z "$PROBE_IP" 443
  ok "worker network: tcp/443 to a public address outside cf4 and worker_dst4 is dropped (the final drop)"
  probe mjk-egress none nc -w 2 -z "$WORKER_DST_IP" 443
  ok "worker network: tcp/443 to an address in worker_dst4 passes this table (no drop counter moves)"
  probe mjk-egress final nc -w 2 -z "$WORKER_DST_IP" 80
  ok "worker network: tcp/80 to an address in worker_dst4 is dropped (the set opens 443 only)"
  probe mjk-api-egress final nc -w 2 -z "$PROBE_IP" 443
  ok "api network: tcp/443 to an address outside cf4 is dropped"
  probe mjk-api-egress final nc -w 2 -z "$WORKER_DST_IP" 443
  ok "api network: tcp/443 to an address in worker_dst4 is dropped (the set is the worker's only)"
  probe mjk-publish final nc -w 2 -z "$PROBE_IP" 443
  ok "publish network: no egress at all"
  probe mjk-tunnel final nc -w 2 -z "$PROBE_IP" 443
  ok "tunnel network: only 7844 to cf_tunnel4 (tcp/443 to a public address is dropped)"
  probe mjk-egress final nslookup example.org "$PROBE_IP"
  ok "DNS to an address that is not in resolvers4 is dropped"
  probe mjk-egress none nslookup example.org "$TEST_RESOLVER"
  ok "DNS to a resolver in resolvers4 passes, ahead of the private-range drop"
else
  skip "no usable host nftables or no default route: the egress probes did not run"
fi

# Docker's embedded DNS (127.0.0.11) asks the host's resolvers from the host's namespace, where
# table inet mjk does not look, so the table cannot stop it (proven on the VM, 2026-11-26). What a
# container gets for a reserved name that no resolver knows (RFC 6761): NXDOMAIN when Docker forwarded
# it, SERVFAIL when it did not. The worker is the control: its NXDOMAIN shows this host can forward
# (its A and AAAA queries leave through the runner's resolver; a reserved name, no service).
embedded_dns() { # <container> <name>
  docker run --rm --network "container:$1" --user 63532:63532 --read-only --cap-drop ALL --security-opt no-new-privileges \
    "$STANDIN_IMAGE" timeout 10 nslookup "$2" 127.0.0.11 2>&1 || true
}
dns_verdict() { grep -o -m 1 -E 'NXDOMAIN|SERVFAIL|timed out' <<<"$1" || echo 'no answer'; }
control=$(dns_verdict "$(embedded_dns mjk-worker-1 mjk-e2e.invalid)")
if [[ $control == NXDOMAIN ]]; then
  for c in mjk-caddy-1 mjk-ssr-1; do
    verdict=$(dns_verdict "$(embedded_dns "$c" mjk-e2e.invalid)")
    [[ $verdict == SERVFAIL ]] || fail "$c can resolve outside names through Docker's embedded DNS ($verdict; caddy needs dns: 127.0.0.1)"
  done
  for name in api ssr; do
    grep -q '^Address: 10\.63\.2\.' <<<"$(embedded_dns mjk-caddy-1 "$name")" || fail "caddy cannot resolve $name on mjk-edge"
  done
  ok "Docker's embedded DNS: the worker's outside lookup is forwarded; caddy and ssr get SERVFAIL; caddy still resolves api and ssr"
else
  skip "the worker's control lookup got '$control', not NXDOMAIN: this host does not forward container DNS, so the caddy and ssr DNS checks did not run"
fi

# --- 5. rollback -------------------------------------------------------------------------------------
step "5. rollback: a server image that never gets healthy"
mkdir -p "$SCRATCH/broken"
cat >"$SCRATCH/broken/main.ts" <<'EOF'
// The e2e's broken image: migrate and healthcheck are the real roles, every daemon just sleeps and
// never writes its heartbeat, so its (real) healthcheck fails.
const role = process.argv[2];
if (role === 'migrate' || role === 'healthcheck') {
  const { run } = await import('./real-main.ts');
  process.exitCode = await run(process.argv.slice(2), process.env);
} else {
  setInterval(() => {}, 2 ** 30);
}
EOF
cat >"$SCRATCH/broken/Dockerfile" <<EOF
FROM $SERVER_IMAGE AS real
FROM $SERVER_IMAGE
COPY --from=real /app/apps/server/src/main.ts /app/apps/server/src/real-main.ts
COPY main.ts /app/apps/server/src/main.ts
EOF
docker build -q -t "$BROKEN_IMAGE" "$SCRATCH/broken" >/dev/null || fail "could not build the broken image"
cur_before=$(sha256sum "$STATE/current.env")
if rb_out=$(run_update --server "$BROKEN_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1); then
  echo "$rb_out" >&2
  fail "mjk-update with a broken image exited 0"
fi
indent <<<"$rb_out"
grep -q 'rollback done' <<<"$rb_out" || fail "no 'rollback done' in the output"
[[ $cur_before == "$(sha256sum "$STATE/current.env")" ]] || fail "current.env changed after a failed deploy"
[[ -f $STATE/failed.env ]] || fail "failed.env was not written"
grep -qx "MJK_SERVER_IMAGE=$BROKEN_IMAGE" "$STATE/failed.env" || fail "failed.env does not name the broken image"
for svc in db api ssr worker media caddy cloudflared; do
  id=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter "label=com.docker.compose.service=$svc" --filter label=com.docker.compose.oneoff=False)
  [[ -n $id ]] || fail "after the rollback there is no running container for $svc"
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$id") == healthy ]] || fail "after the rollback $svc is not healthy"
done
api_id=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.service=api)
[[ $(docker inspect -f '{{.Config.Image}}' "$api_id") == "$SERVER_IMAGE" ]] || fail "the api does not run the previous image after the rollback"
[[ $(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1:8280/api/v1/healthz) == 200 ]] || fail "the site does not answer after the rollback"
ok "a broken image: mjk-update exits 1, current.env unchanged, failed.env names the broken image, the previous images are healthy again, the site answers"

# --- 6. mjk-tick -------------------------------------------------------------------------------------
step "6. mjk-tick"
if ((HAVE_NFT)); then
  nft delete table inet mjk
  "$BIN/mjk-tick" >/dev/null || fail "mjk-tick failed with the table deleted"
  nft list table inet mjk >/dev/null 2>&1 || fail "mjk-tick did not reload the deleted table"
  nft list set inet mjk resolvers4 | grep -q '192.0.2.53' || fail "mjk-tick did not refill resolvers4"
  nft list set inet mjk worker_dst4 | grep -qF "$WORKER_DST_IP" || fail "mjk-tick did not refill worker_dst4"
  grep -Eq '^free_pct=[0-9]+$' "$STATE/guard/disk" || fail "mjk-tick did not write the disk file"
  ok "a deleted table is loaded again, resolvers4 and worker_dst4 are refilled, the disk file is written"
else
  skip "mjk-tick's table steps need a host nftables that can load a table"
fi

# An unhealthy container of the project is restarted (Docker never restarts one).
docker run -d --name mjk-e2e-stray --label com.docker.compose.project=mjk --label com.docker.compose.service=e2e-stray \
  --health-cmd false --health-interval 1s --health-retries 1 --network none "$STANDIN_IMAGE" sleep 600 >/dev/null
for _ in $(seq 1 30); do
  [[ $(docker inspect -f '{{.State.Health.Status}}' mjk-e2e-stray) == unhealthy ]] && break
  sleep 1
done
[[ $(docker inspect -f '{{.State.Health.Status}}' mjk-e2e-stray) == unhealthy ]] || fail "the stray container did not become unhealthy"
started_before=$(docker inspect -f '{{.State.StartedAt}}' mjk-e2e-stray)
# As during a nightly backup: the lock is held shared.
exec 8>"$TESTROOT/run/mjk/deploy.lock"
flock -s -n 8 || fail "could not take the deploy lock shared in the test"
"$BIN/mjk-tick" >/dev/null || fail "mjk-tick failed"
exec 8>&-
[[ $started_before != "$(docker inspect -f '{{.State.StartedAt}}' mjk-e2e-stray)" ]] || fail "mjk-tick did not restart the unhealthy container"
docker rm -f mjk-e2e-stray >/dev/null
ok "an unhealthy container of the project is restarted, also while a backup holds the lock shared"

# As during a deploy: the lock is held exclusive. The tick only checks the table, resolvers4 and the disk.
rm -f "$STATE/guard/disk"
exec 8>"$TESTROOT/run/mjk/deploy.lock"
flock -x -n 8 || fail "could not take the deploy lock in the test"
tick_out=$(MJK_TICK_LOCK_WAIT=1 "$BIN/mjk-tick" 2>&1) || fail "mjk-tick with a deploy holding the lock did not exit 0: $tick_out"
exec 8>&-
grep -q 'busy' <<<"$tick_out" || fail "mjk-tick with a deploy holding the lock did not say busy: $tick_out"
grep -Eq '^free_pct=[0-9]+$' "$STATE/guard/disk" || fail "mjk-tick did not write the disk file while a deploy held the lock"
ok "while a deploy holds the lock mjk-tick still writes the disk file and says busy"

# A lock directory that is not root 0700 (as if someone else had made it): the tick still does the
# firewall and disk steps and exits 1; mjk-update refuses.
chmod 0755 "$TESTROOT/run/mjk"
rm -f "$STATE/guard/disk"
if tick_out=$("$BIN/mjk-tick" 2>&1); then fail "mjk-tick exited 0 with an unusable lock directory: $tick_out"; fi
grep -q 'cannot be opened' <<<"$tick_out" || fail "mjk-tick did not name the unusable lock: $tick_out"
grep -Eq '^free_pct=[0-9]+$' "$STATE/guard/disk" || fail "mjk-tick did not write the disk file with an unusable lock"
if upd_out=$(run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" 2>&1); then fail "mjk-update ran with an unusable lock directory"; fi
grep -q 'lock_unusable' <<<"$upd_out" || fail "mjk-update did not say lock_unusable: $upd_out"
chmod 0700 "$TESTROOT/run/mjk"
ok "with an unusable lock directory mjk-tick still checks the firewall and the disk and exits 1; mjk-update refuses"

if ((HAVE_NFT)); then
  # Fail closed: the table cannot be loaded.
  nft delete table inet mjk
  cp "$ETC/mjk.nft" "$SCRATCH/mjk.nft.good"
  printf 'this is not nft syntax\n' >>"$ETC/mjk.nft"
  if "$BIN/mjk-tick" >/dev/null 2>&1; then fail "mjk-tick exited 0 although the table cannot be loaded"; fi
  [[ -z $(docker ps -q --filter label=com.docker.compose.project=mjk) ]] || fail "the stack is still running without its table"
  [[ -f $STATE/firewall-stopped ]] || fail "firewall-stopped was not written"
  if nft list table inet mjk >/dev/null 2>&1; then fail "a broken nft file loaded a table"; fi
  # mjk-update refuses while the table is missing.
  if run_update --server "$SERVER_IMAGE" --web "$WEB_IMAGE" --backup "$BACKUP_IMAGE" >/dev/null 2>&1; then fail "mjk-update ran without the table"; fi
  ok "when the table cannot be loaded mjk-tick stops the stack and writes firewall-stopped; mjk-update refuses to deploy"
  # The file is good again: the next tick loads it and starts current.env.
  cp "$SCRATCH/mjk.nft.good" "$ETC/mjk.nft"
  "$BIN/mjk-tick" >/dev/null || fail "mjk-tick failed once the file was good again"
  [[ ! -e $STATE/firewall-stopped ]] || fail "firewall-stopped is still there"
  nft list table inet mjk >/dev/null 2>&1 || fail "the table is not loaded again"
  for _ in $(seq 1 60); do
    unhealthy=0
    for svc in db api ssr worker caddy cloudflared; do
      id=$(docker ps -q --filter label=com.docker.compose.project=mjk --filter "label=com.docker.compose.service=$svc" --filter label=com.docker.compose.oneoff=False)
      [[ -n $id && $(docker inspect -f '{{.State.Health.Status}}' "$id") == healthy ]] || unhealthy=1
    done
    ((unhealthy)) || break
    sleep 2
  done
  ((!unhealthy)) || fail "the stack is not healthy after the table came back"
  ok "once the table loads again mjk-tick starts current.env and removes firewall-stopped; every daemon is healthy"
else
  skip "mjk-tick's fail-closed steps need a host nftables that can load a table"
fi

# --- 7. the backup unit's command and the ping -------------------------------------------------------
step "7. mjk-backup.service command line and mjk-ping"
exec_line=$(sed -n 's/^ExecStart=//p' "$REPO/deploy/host/systemd/mjk-backup.service")
[[ $exec_line == "/usr/bin/flock -s -w 3600 /run/mjk/deploy.lock /usr/bin/docker compose -p mjk -f /etc/mjk/compose.yaml --env-file /srv/mjk/state/current.env --profile backup run --rm -T backup" ]] ||
  fail "the ExecStart of mjk-backup.service is not the expected command line"
# The same command line in the test root, plus the override: the role itself belongs to WP7 (it may still
# answer "not built yet"); what matters here is that the one-shot starts on the backup image under the lock.
read -r -a backup_cmd <<<"${exec_line//\/etc\/mjk/$ETC}"
backup_cmd=("${backup_cmd[@]//\/srv\/mjk/$SRVD}")
backup_cmd=("${backup_cmd[@]//\/run\/mjk\/deploy.lock/$TESTROOT/run/mjk/deploy.lock}")
backup_cmd=("${backup_cmd[@]/\/usr\/bin\/docker/docker}")
set +e
"${backup_cmd[@]}" >"$SCRATCH/backup.out" 2>&1
backup_rc=$?
set -e
case $backup_rc in
  0 | 2 | 65 | 69 | 70 | 75 | 78) ok "the unit's command line starts the backup one-shot under the lock (the role exited $backup_rc)" ;;
  *)
    cat "$SCRATCH/backup.out" >&2
    fail "the unit's command line failed with $backup_rc before the role ran"
    ;;
esac
[[ -z $(docker ps -a -q --filter label=com.docker.compose.project=mjk --filter label=com.docker.compose.oneoff=True) ]] || fail "run --rm left a one-off container"
if ((HAVE_NFT)); then
  # The backup network exists now (compose creates it for the first backup run).
  probe mjk-backup-egress final nc -w 2 -z "$PROBE_IP" 443
  ok "backup network: tcp/443 to an address outside cf4 is dropped"
fi
dc --profile backup config --format json | jq -e '.services.backup.image == "'"$BACKUP_IMAGE"'"' >/dev/null || fail "the backup service does not use the backup image"

# mjk-ping: a local server that answers slowly, so the process table can be read while curl waits.
cat >"$SCRATCH/hc.py" <<'EOF'
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(sys.argv[2], "a") as f:
            f.write(self.path + "\n")
        time.sleep(2)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
python3 "$SCRATCH/hc.py" 58765 "$SCRATCH/hc.log" &
PING_PID=$!
for _ in $(seq 1 25); do
  if (exec 3<>/dev/tcp/127.0.0.1/58765) 2>/dev/null; then break; fi
  sleep 0.2
done
: >"$SCRATCH/hc.log"
key=$(<"$ETC/secrets/hc_ping_key")
export MJK_HC_BASE=http://127.0.0.1:58765
"$BIN/mjk-ping" ok >"$SCRATCH/ping.out" 2>&1 &
ping_job=$!
sleep 1
if pgrep -f -- "$key" >/dev/null; then fail "the ping key is in the process table"; fi
wait "$ping_job" || fail "mjk-ping ok failed"
SERVICE_RESULT=exit-code "$BIN/mjk-ping" result >>"$SCRATCH/ping.out" 2>&1 || fail "mjk-ping result failed"
SERVICE_RESULT=success "$BIN/mjk-ping" result >>"$SCRATCH/ping.out" 2>&1 || fail "mjk-ping result (success) failed"
unset MJK_HC_BASE
if grep -qF -- "$key" "$SCRATCH/ping.out"; then fail "the ping key is in mjk-ping's output"; fi
[[ $(sed 's#/[^/]*/mjk-backup#/KEY/mjk-backup#' "$SCRATCH/hc.log") == $'/KEY/mjk-backup\n/KEY/mjk-backup/fail\n/KEY/mjk-backup' ]] ||
  fail "mjk-ping requested: $(cat "$SCRATCH/hc.log")"
grep -qx "/$key/mjk-backup" "$SCRATCH/hc.log" || fail "the first ping did not carry the key"
kill "$PING_PID" 2>/dev/null || true
PING_PID=
ok "mjk-ping sends the key on stdin only (absent from the process table and its output): ok, fail on a failed run, ok on success"

# --- 8. units ----------------------------------------------------------------------------------------
step "8. units"
for unit in mjk-update.timer mjk-tick.timer mjk-backup.timer mjk-update.service mjk-tick.service mjk-backup.service mjk-firewall.service mjk-egress.service; do
  [[ -f $TESTROOT/etc/systemd/system/$unit ]] || fail "$unit was not installed"
done
grep -qx 'OnCalendar=\*-\*-\* 01:43:00 Europe/Amsterdam' "$TESTROOT/etc/systemd/system/mjk-backup.timer" || fail "mjk-backup.timer OnCalendar"
grep -qx 'Persistent=true' "$TESTROOT/etc/systemd/system/mjk-backup.timer" || fail "mjk-backup.timer Persistent"
grep -qx 'OnCalendar=\*:07/10' "$TESTROOT/etc/systemd/system/mjk-tick.timer" || fail "mjk-tick.timer OnCalendar"
grep -q '^OnBootSec=' "$TESTROOT/etc/systemd/system/mjk-tick.timer" || fail "mjk-tick.timer has no OnBootSec"
grep -qx 'OnCalendar=\*:0/10' "$TESTROOT/etc/systemd/system/mjk-update.timer" || fail "mjk-update.timer OnCalendar"
if command -v systemd-analyze >/dev/null; then
  # Only the verdicts on the timers' schedules: the services name /usr/bin/docker and /usr/local/bin files that
  # are not under any root the analyzer can see.
  systemd-analyze calendar '*:07/10' '*:0/10' '*-*-* 01:43:00 Europe/Amsterdam' >/dev/null || fail "a timer's OnCalendar does not parse"
fi
# The lookups never hold up Docker (P3b review): mjk-firewall.service (Before=docker.service) runs no
# mjk-egress and allows no inet socket; mjk-egress.service runs after it and is not ordered before Docker.
fw=$TESTROOT/etc/systemd/system/mjk-firewall.service
eg=$TESTROOT/etc/systemd/system/mjk-egress.service
if grep -q '^Exec.*mjk-egress' "$fw"; then fail "mjk-firewall.service still runs mjk-egress"; fi
grep -qx 'RestrictAddressFamilies=AF_NETLINK AF_UNIX' "$fw" || fail "mjk-firewall.service allows more than AF_NETLINK AF_UNIX"
grep -qx 'Wants=network-online.target mjk-egress.service' "$fw" || fail "mjk-firewall.service does not want mjk-egress.service"
grep -qx 'After=mjk-firewall.service network-online.target' "$eg" || fail "mjk-egress.service is not ordered after the firewall"
if grep -q '^Before=' "$eg"; then fail "mjk-egress.service is ordered before another unit"; fi
grep -qx 'ExecStart=-/usr/local/bin/mjk-egress' "$eg" || fail "mjk-egress.service does not run mjk-egress"
ok "the eight units are installed; mjk-egress.service runs the lookups after the firewall, never before Docker; the timers are 10 minutes (:00 and :07, tick also after boot) and 01:43 Europe/Amsterdam with Persistent=true"

step "teardown happens in the EXIT trap"
echo "e2e: all steps passed"
