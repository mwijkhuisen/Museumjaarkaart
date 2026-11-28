#!/usr/bin/env bash
# P1e criterion 1 (job `ci / deploy`): the production compose file keeps the hardening of
# A§16.1 and A§17.2/17.3. It renders the file with `docker compose config` (every profile, dummy
# image refs, no environment from the caller or a .env file) and asserts, for every service:
# read_only, tmpfs /tmp, cap_drop ALL, no-new-privileges, user 63532:63532, mem, cpus and
# pids_limit; no privileged, cap_add, host namespaces, devices, docker.sock or another project's
# paths. Only 127.0.0.1:8280 is published; the eight mjk-* networks match A§17.3; the secrets
# come from /etc/mjk/secrets and group_add matches A§17.3's table; no environment key looks like
# a secret and none is DATABASE_URL; no name holds `rws` or `f1` (names only, never digests).
# P3b: `media` (the photo decoder) has network_mode none, no network, secret or GID; no other service
# may set network_mode. Its only mount is the volume media-work at /srv/mjk/media-work (no bind, so no
# host path), it has no env_file and no environment, and that volume is a size-capped tmpfs (P3b review).
#   deploy/tests/hardening.sh [compose file]    (default: deploy/compose.yaml)
# The argument exists for the mutation checks on a temporary copy: without one, after the file passes, the
# script runs itself on mutated copies of it (media with originals mounted, with mjk.env, with an
# environment, with media-work as a host bind, with an uncapped media-work) and each must fail. The production paths
# (/etc/mjk, /srv/mjk) stay literal in the file. Compose v5 renders it with `--no-env-resolution`
# without reading /etc/mjk/mjk.env, but Compose v2 (the GitHub runner's, 2.38) still reads every
# env_file. So the check renders a staged copy: every /etc/mjk/ and /srv/mjk/ path outside a comment
# is moved below a temporary root with empty stand-in files, and the rendered JSON is mapped back
# before any assertion, so the assertions see (and require) the production paths exactly. A path
# that the staging did not move, or a staged path that did not map back, is a violation.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
compose_file=${1:-$here/../compose.yaml}
[[ -f $compose_file ]] || { echo "hardening: no compose file at $compose_file" >&2; exit 2; }
command -v jq >/dev/null || { echo "hardening: jq is required" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "hardening: docker compose is required" >&2; exit 2; }

digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The staged copy (see above). The stage path is random; it may not occur in the file itself.
stage=$tmp/stage
! grep -qF -- "$stage" "$compose_file" || { echo "hardening: the stage path occurs in $compose_file" >&2; exit 2; }
staged=$tmp/compose.yaml
sed -E "/^[[:space:]]*#/! s#(^|[^A-Za-z0-9_./-])/(etc|srv)/mjk/#\1$stage/\2/mjk/#g" "$compose_file" >"$staged"
# One stand-in, for exactly /etc/mjk/mjk.env, the only file rendering reads (Compose v2 reads
# env_file; secret files and bind sources are not opened). So an env_file that names any other path
# still fails: Compose v2 cannot find it, and under v5 the env_file check below names it. Compose v2 also
# folds an env_file into `environment` and drops the key from its output, so the stand-in holds one
# sentinel key: an env_file on `media` then shows as that environment key under v2 (proven with Compose
# 2.40.3: an empty stand-in let the env-file mutation through) and as the env_file under v5.
mkdir -p "$stage/etc/mjk"
printf 'MJK_HARDENING_STANDIN=1\n' >"$stage/etc/mjk/mjk.env"

# env -i: no COMPOSE_* or MJK_* from the caller; --env-file /dev/null: no .env next to the file.
env -i PATH="$PATH" HOME="${HOME:-$tmp}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
  MJK_SERVER_IMAGE="ghcr.io/mwijkhuisen/mjk-server:hardening@$digest" \
  MJK_WEB_IMAGE="ghcr.io/mwijkhuisen/mjk-web:hardening@$digest" \
  MJK_BACKUP_IMAGE="ghcr.io/mwijkhuisen/mjk-backup:hardening@$digest" \
  docker compose -f "$staged" --env-file /dev/null --profile '*' \
  config --no-env-resolution --format json >"$tmp/staged.json"
# Back to the production paths: a string that starts with the stage path loses exactly that prefix.
jq --arg stage "$stage" 'walk(if type == "string" and startswith($stage + "/") then .[($stage | length):] else . end)' \
  "$tmp/staged.json" >"$tmp/config.json"
if grep -qF -- "$stage" "$tmp/config.json"; then
  echo "FAIL a staged path did not map back to a production path" >&2
  exit 1
fi

# A§17.3 (with interfaces.md's change: hc_ping_key goes to worker only, and the least-privilege
# decision: r2_media_rw, GID 63009, is the worker's since P1d; P2a adds app_keys, GID 63012, to api, worker
# and admin, and lettermint_api_token, GID 63008, to worker only). Each service's secrets
# are its consumers' column; its group_add must be exactly the GIDs of those secrets.
expected=$(
  cat <<'JSON'
{
  "gids": {
    "db_postgres": "63001", "db_mjk_migrator": "63002", "db_mjk_api": "63003",
    "db_mjk_ssr": "63004", "db_mjk_worker": "63005", "db_mjk_backup": "63006",
    "cf_tunnel_token": "63007", "lettermint_api_token": "63008", "r2_media_rw": "63009", "r2_backup_put": "63010", "restic_password": "63011",
    "hc_ping_key": "63013", "app_keys": "63012"
  },
  "services": {
    "db": {"networks": ["mjk-db"],
           "secrets": ["db_postgres", "db_mjk_migrator", "db_mjk_api", "db_mjk_ssr", "db_mjk_worker", "db_mjk_backup"]},
    "migrate": {"networks": ["mjk-db"], "secrets": ["db_mjk_migrator"]},
    "api": {"networks": ["mjk-edge", "mjk-db", "mjk-api-egress"], "secrets": ["db_mjk_api", "app_keys"]},
    "ssr": {"networks": ["mjk-edge", "mjk-db"], "secrets": ["db_mjk_ssr"]},
    "media": {"networks": [], "secrets": []},
    "worker": {"networks": ["mjk-egress", "mjk-db"],
               "secrets": ["db_mjk_worker", "hc_ping_key", "r2_media_rw", "app_keys", "lettermint_api_token"]},
    "caddy": {"networks": ["mjk-edge", "mjk-tunnel-edge", "mjk-publish"], "secrets": []},
    "cloudflared": {"networks": ["mjk-tunnel", "mjk-tunnel-edge"], "secrets": ["cf_tunnel_token"]},
    "backup": {"networks": ["mjk-db", "mjk-backup-egress"],
               "secrets": ["db_mjk_backup", "r2_backup_put", "restic_password"]},
    "sync-museums": {"networks": ["mjk-egress", "mjk-db"], "secrets": ["db_mjk_worker"]},
    "admin": {"networks": ["mjk-db"], "secrets": ["db_mjk_api", "app_keys"]}
  },
  "networks": {
    "mjk-db": {"subnet": "10.63.1.0/24", "internal": true},
    "mjk-edge": {"subnet": "10.63.2.0/24", "internal": true},
    "mjk-egress": {"subnet": "10.63.3.0/24", "internal": false},
    "mjk-api-egress": {"subnet": "10.63.4.0/24", "internal": false},
    "mjk-tunnel": {"subnet": "10.63.5.0/24", "internal": false},
    "mjk-tunnel-edge": {"subnet": "10.63.6.0/24", "internal": true},
    "mjk-publish": {"subnet": "10.63.7.0/24", "internal": false},
    "mjk-backup-egress": {"subnet": "10.63.8.0/24", "internal": false, "bridge": "mjk-bkp-egress"}
  },
  "addresses": ["caddy mjk-edge 10.63.2.10", "cloudflared mjk-tunnel-edge 10.63.6.10"],
  "ports": [{"service": "caddy", "host_ip": "127.0.0.1", "published": "8280", "target": "80", "protocol": "tcp"}],
  "sysctls": {"net.ipv4.ip_unprivileged_port_start": "80"}
}
JSON
)

# One line per violation. Names are matched, never image refs (a digest can hold "f1").
read -r -d '' checks <<'JQ' || true
def fail($m): "FAIL " + $m;
def num: if . == null then 0 else (tostring | tonumber? // 0) end;
def args: if . == null then empty elif type == "array" then .[] else tostring end;
def forbidden_path: test("docker\\.sock|^/(etc|srv)/(rws|f1)(/|$)|(^|/)\\.\\.(/|$)");

. as $c
| $exp.services as $es | $exp.networks as $en | $exp.gids as $eg
| ($c.networks // {}) as $nets
| (
  (if $c.name != "mjk" then fail("the project name is \($c.name | tojson), not mjk") else empty end),

  (($c.services | keys) as $have | ($es | keys) as $want
    | if $have != $want then fail("services \($have | join(" ")); expected \($want | join(" "))") else empty end),

  ($c.services | to_entries[] | .key as $n | .value as $s
    | ($s.profiles // [] | length > 0) as $job
    | (if $s.read_only != true then fail("\($n): read_only is not true") else empty end),
      (if [$s.tmpfs[]? | select(. == "/tmp" or startswith("/tmp:"))] | length == 0
       then fail("\($n): no tmpfs /tmp") else empty end),
      (if $s.cap_drop != ["ALL"] then fail("\($n): cap_drop is \($s.cap_drop | tojson), not [\"ALL\"]") else empty end),
      (if any($s.security_opt[]?; . == "no-new-privileges:true" or . == "no-new-privileges") | not
       then fail("\($n): no no-new-privileges") else empty end),
      ($s.security_opt[]? | select(test("unconfined|disable"; "i")) | fail("\($n): security_opt \(.)")),
      (if $s.user != "63532:63532" then fail("\($n): user is \($s.user | tojson), not 63532:63532") else empty end),
      (if ($s.mem_limit | num) <= 0 then fail("\($n): no mem_limit") else empty end),
      (if ($s.cpus | num) <= 0 then fail("\($n): no cpus limit") else empty end),
      (if ($s.pids_limit | num) <= 0 then fail("\($n): no pids_limit") else empty end),
      (if $s.privileged == true then fail("\($n): privileged") else empty end),
      (if ($s.cap_add // []) | length > 0 then fail("\($n): cap_add \($s.cap_add | tojson)") else empty end),
      (if $n == "media" then (if $s.network_mode != "none" then fail("media: network_mode \($s.network_mode | tojson), not \"none\"") else empty end)
       elif $s.network_mode != null then fail("\($n): network_mode \($s.network_mode)") else empty end),
      (if $n == "media" then
         ([$s.volumes[]? | {type, source, target}]) as $mv
         | (if $mv != [{"type": "volume", "source": "media-work", "target": "/srv/mjk/media-work"}]
            then fail("media: mounts \($mv | tojson); only the volume media-work at /srv/mjk/media-work") else empty end),
           (if ($s.env_file // []) | length > 0 then fail("media: env_file \([$s.env_file[]? | .path] | join(" "))") else empty end),
           (if ($s.environment // {}) | length > 0 then fail("media: environment \($s.environment | keys | join(" "))") else empty end)
       else empty end),
      (["pid", "ipc", "uts", "userns_mode", "cgroup"][] as $k
        | select($s[$k] != null and $s[$k] != "private") | fail("\($n): \($k) \($s[$k])")),
      (if ($s.devices // []) | length > 0 then fail("\($n): devices") else empty end),
      (if $s.volumes_from != null then fail("\($n): volumes_from") else empty end),
      ($s.volumes[]? | . as $v | ($v.source // "") as $src
        | (if $src | forbidden_path then fail("\($n): mounts \($src)") else empty end),
          (if $v.type == "bind" then
             (if $src | test("^/(etc|srv)/mjk/") | not
              then fail("\($n): bind mount \($src) outside /etc/mjk and /srv/mjk") else empty end)
           elif $v.type == "volume" then
             (if ($c.volumes // {}) | has($src) | not then fail("\($n): undeclared volume \($src)") else empty end)
           elif $v.type == "tmpfs" then empty
           else fail("\($n): mount type \($v.type)") end)),
      (if ($s.image // "") | test("@sha256:[0-9a-f]{64}$") | not
       then fail("\($n): image \($s.image | tojson) is not pinned by digest") else empty end),
      (if $job then (if $s.restart != "no" then fail("\($n): a job with restart \($s.restart | tojson)") else empty end)
       else (if $s.restart != "unless-stopped" then fail("\($n): restart \($s.restart | tojson)") else empty end),
            (if ($s.healthcheck.test // []) | length == 0 or $s.healthcheck.disable == true
             then fail("\($n): a daemon without a healthcheck") else empty end) end),
      (if $s.logging.driver != "local" then fail("\($n): log driver \($s.logging.driver | tojson), not local") else empty end),
      ($s.environment // {} | keys[]
        | select((test("PASSWORD|TOKEN|SECRET|KEY"; "i") and (endswith("_FILE") | not)) or . == "DATABASE_URL")
        | fail("\($n): environment key \(.) looks like a secret")),
      ([($s.command | args), ($s.entrypoint | args)][]
        | select(test("^--token(=|$)|DATABASE_URL|postgres(ql)?://"; "i"))
        | fail("\($n): a secret-like argument \(.)")),
      ($s.env_file[]? | .path | select(. != "/etc/mjk/mjk.env") | fail("\($n): env_file \(.)")),
      ($s.sysctls // {} | to_entries[]
        | select(($n != "caddy") or ($exp.sysctls[.key] != (.value | tostring)))
        | fail("\($n): sysctl \(.key)=\(.value)")),
      (if $es[$n] then
        ([$s.secrets[]? | .source] | sort) as $have | ($es[$n].secrets | sort) as $want
        | (if $have != $want then fail("\($n): secrets \($have | join(" ")); A§17.3: \($want | join(" "))") else empty end),
          ($s.secrets[]? | select(.target != null and .target != "/run/secrets/" + .source)
            | fail("\($n): secret \(.source) mounted at \(.target)")),
          ([$s.group_add[]? | tostring] | sort) as $gh | ([$es[$n].secrets[] | $eg[.]] | sort) as $gw
          | (if $gh != $gw then fail("\($n): group_add \($gh | join(" ")); A§17.3: \($gw | join(" "))") else empty end),
          ($s.networks // {} | keys) as $nh | ($es[$n].networks | sort) as $nw
          | (if $nh != $nw then fail("\($n): networks \($nh | join(" ")); A§17.3: \($nw | join(" "))") else empty end)
       else empty end),
      ([$s.networks // {} | keys[] | select(($nets[.].internal // false) | not)] | length) as $public
      | (if $public > 1 then fail("\($n): \($public) non-internal networks") else empty end),
        (if $n == "ssr" and $public > 0 then fail("ssr: on a non-internal network") else empty end)),

  ([$c.services | to_entries[] | .key as $n | .value.ports[]?
     | {service: $n, host_ip, published: (.published | tostring), target: (.target | tostring), protocol}] as $have
   | if $have != $exp.ports then fail("published ports \($have | tojson); only caddy 127.0.0.1:8280->80/tcp") else empty end),

  ([$c.services | to_entries[] | .key as $n | .value.networks // {} | to_entries[]
     | select(.value.ipv4_address? != null) | "\($n) \(.key) \(.value.ipv4_address)"] | sort) as $have
  | (if $have != ($exp.addresses | sort) then fail("fixed addresses \($have | tojson)") else empty end),

  (($nets | keys) as $have | ($en | keys) as $want
    | if $have != $want then fail("networks \($have | join(" ")); A§17.3: \($want | join(" "))") else empty end),
  ($nets | to_entries[] | .key as $k | .value as $v
    | ($v.driver_opts["com.docker.network.bridge.name"] // "") as $br
    | (if $v.name != $k then fail("network \($k) is named \($v.name | tojson)") else empty end),
      (if $v.driver != "bridge" then fail("network \($k): driver \($v.driver | tojson)") else empty end),
      (if $v.external == true then fail("network \($k) is external") else empty end),
      (if $v.enable_ipv6 == true then fail("network \($k) has IPv6") else empty end),
      ($v.ipam.config[]?.subnet | select(test("^10\\.63\\.[0-9]{1,3}\\.[0-9]{1,3}/(1[6-9]|2[0-9]|3[0-2])$") | not)
        | fail("network \($k): subnet \(.) outside 10.63.0.0/16")),
      (if ($br | test("^mjk-[a-z0-9-]+$") | not) or ($br | length) > 15
       then fail("network \($k): bridge name \($br | tojson) (mjk-*, at most 15 characters)") else empty end),
      (if $en[$k] then
        (if [$v.ipam.config[]?.subnet] != [$en[$k].subnet]
         then fail("network \($k): subnets \([$v.ipam.config[]?.subnet] | join(" ")); A§17.3: \($en[$k].subnet)") else empty end),
        (if ($v.internal // false) != $en[$k].internal then fail("network \($k): internal is \($v.internal // false)") else empty end),
        (if $br != ($en[$k].bridge // $k) then fail("network \($k): bridge \($br)") else empty end),
        (if ($en[$k].internal | not) and $v.driver_opts["com.docker.network.bridge.enable_icc"] != "false"
         then fail("network \($k): enable_icc is not false") else empty end)
       else empty end)),

  (($c.volumes["media-work"].driver_opts // {}) as $o
    | if $o.type != "tmpfs" or $o.device != "tmpfs" or (($o.o // "") | test("(^|,)size=[1-9][0-9]*[kmg]?(,|$)") | not)
      then fail("volume media-work is not a size-capped tmpfs: \($o | tojson)") else empty end),
  ($c.volumes // {} | to_entries[]
    | (if (.value.name // "") | startswith("mjk_") | not then fail("volume \(.key) is named \(.value.name | tojson)") else empty end),
      (if .value.external == true then fail("volume \(.key) is external") else empty end)),

  ((($c.secrets // {}) | keys) as $have | ($eg | keys) as $want
    | if $have != $want then fail("secrets \($have | join(" ")); A§17.3: \($want | join(" "))") else empty end),
  ($c.secrets // {} | to_entries[]
    | (if .value.file != "/etc/mjk/secrets/" + .key then fail("secret \(.key) from \(.value.file // .value | tojson)") else empty end),
      (if .value.environment != null or .value.external == true or .value.content != null
       then fail("secret \(.key) is not a file secret") else empty end)),

  ([$c.name,
    ($c.services | keys[]),
    ($c.services[] | .container_name, .hostname, (.networks // {} | keys[]), (.secrets[]? | .source)),
    ($nets | keys[]), ($nets[] | .name, .driver_opts["com.docker.network.bridge.name"]?),
    ($c.volumes // {} | keys[]), ($c.volumes // {} | .[] | .name),
    ($c.secrets // {} | keys[]), ($c.secrets // {} | .[] | .name, .file)]
   | map(select(. != null)) | unique[]
   | select(test("rws|f1"; "i")) | fail("the name \(.) holds rws or f1"))
)
JQ

violations=$(jq -r --argjson exp "$expected" "$checks" "$tmp/config.json")
if [[ -n $violations ]]; then
  printf '%s\n' "$violations" >&2
  echo "hardening: $(grep -c '^FAIL' <<<"$violations") violation(s) in $compose_file" >&2
  exit 1
fi
echo "hardening: ok ($(jq '.services | length' "$tmp/config.json") services, $(jq '.networks | length' "$tmp/config.json") networks)"

# The mutation checks (P3b review): only on a run without an argument, so a mutated copy never recurses.
(($# == 0)) || exit 0
# A copy of the file with `vol` printed after media's `volumes:` line and `top` after its command line.
media_mutant() {
  awk -v vol="$2" -v top="$3" '
    /^  [a-z][a-z-]*:$/ { inm = ($0 == "  media:") }
    { print }
    inm && vol != "" && /^    volumes:$/ { print vol }
    inm && top != "" && /^    command: \["media"\]$/ { print top }
  ' "$compose_file" >"$1"
}
mut=$tmp/mutants
mkdir "$mut"
media_mutant "$mut/originals.yaml" $'      - type: bind\n        source: /srv/mjk/originals\n        target: /srv/mjk/originals\n        bind:\n          create_host_path: false' ''
media_mutant "$mut/env-file.yaml" '' $'    env_file:\n      - path: /etc/mjk/mjk.env\n        required: true'
media_mutant "$mut/environment.yaml" '' $'    environment:\n      MJK_DOMAIN: example.test'
sed '/^  media:$/,/^  [a-z][a-z-]*:$/ { s#- type: volume#- type: bind#; s#source: media-work#source: /srv/mjk/media-work# }' \
  "$compose_file" >"$mut/bind.yaml"
sed '/^  media-work:$/,/^[a-z]/ s#o: "size=[^,]*,#o: "#' "$compose_file" >"$mut/uncapped.yaml"
# The env-file mutation fails as `media: env_file` under Compose v5 and as `media: environment
# MJK_HARDENING_STANDIN` under v2 (see the stand-in above): either of media's two env pins.
declare -A want=(
  [originals]='media: mounts' [env-file]='media: env' [environment]='media: environment'
  [bind]='media: mounts' [uncapped]='volume media-work is not a size-capped tmpfs'
)
for name in "${!want[@]}"; do
  cmp -s "$compose_file" "$mut/$name.yaml" && { echo "hardening: the mutation $name changed nothing" >&2; exit 1; }
  if "${BASH_SOURCE[0]}" "$mut/$name.yaml" >"$mut/$name.out" 2>&1; then
    echo "FAIL the mutation $name passed" >&2
    exit 1
  fi
  grep -qF -- "FAIL ${want[$name]}" "$mut/$name.out" || {
    cat "$mut/$name.out" >&2
    echo "FAIL the mutation $name failed for another reason" >&2
    exit 1
  }
done
echo "hardening: ${#want[@]} mutations of media's mounts, environment and media-work refused"
