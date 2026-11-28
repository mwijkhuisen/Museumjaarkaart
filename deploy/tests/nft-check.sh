#!/usr/bin/env bash
# nft-check: the static and load checks of table inet mjk (A§17.4, A§18; job `ci / deploy`).
#   deploy/tests/nft-check.sh
# 1. No statement that empties the whole ruleset anywhere under deploy/ (it would delete Docker's,
#    Waterheight's and F1's tables).
# 2. deploy/host/nftables/mjk.nft names no table but `inet mjk`, includes no file and never names the
#    ruleset.
# 3. `nft -c -f` accepts the file.
# 4. In a throw-away network namespace (unshare -n; it disappears when its last process exits): the file
#    loads twice with the same listing, holds only table inet mjk, every accept of the egress chain is one
#    of the expected source and destination sets (the worker's tcp/443 only to cf4 or worker_dst4);
#    mjk-resolvers fills resolvers4, refuses a loopback-only resolv.conf and a missing table; mjk-egress
#    replaces worker_dst4 when every host resolves, only adds when one does not, changes nothing when none
#    does or the list is bad. Its lists hold literal addresses and reserved .invalid names only, so no
#    outside name is ever looked up. The host's own ruleset is never touched.
# Steps 3 and 4 need nft and root (or an unprivileged user namespace). Without them the steps are
# skipped with a message, except under CI, where a skip is a failure.
set -euo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NFT_FILE=$ROOT/deploy/host/nftables/mjk.nft
RESOLVERS=$ROOT/deploy/bin/mjk-resolvers
EGRESS=$ROOT/deploy/bin/mjk-egress
SELF=$ROOT/deploy/tests/nft-check.sh

fail() {
  echo "nft-check: FAIL: $1" >&2
  exit 1
}
ok() { echo "nft-check: ok: $1"; }
# The elements of a set of table inet mjk, sorted and comma-separated (empty when it has none).
elements() { nft list set inet mjk "$1" | tr -d '\n\t ' | sed -nE 's/.*elements=\{([^}]*)\}.*/\1/p' | tr ',' '\n' | sort | paste -sd, -; }
skip() {
  if [[ -n ${CI:-} ]]; then fail "$1 (a skip is a failure under CI)"; fi
  echo "nft-check: SKIP: $1" >&2
}

# --- In the namespace (the script runs itself here through unshare) --------------------------------------
in_netns() {
  # Refuse to run anywhere but a fresh namespace: never load or delete a table on the host.
  [[ -n ${MJK_NFT_CHECK_PARENT_NS:-} ]] || fail "--in-netns is internal; run the script without arguments"
  [[ $(readlink /proc/self/ns/net) != "$MJK_NFT_CHECK_PARENT_NS" ]] || fail "not in a new network namespace"
  [[ -z $(nft list ruleset) ]] || fail "the new namespace has a ruleset already"

  local first second tables
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  nft -f "$NFT_FILE" || fail "first load"
  nft list table inet mjk >"$tmp/first"
  nft -f "$NFT_FILE" || fail "second load (the reload must be idempotent)"
  nft list table inet mjk >"$tmp/second"
  first=$(<"$tmp/first")
  second=$(<"$tmp/second")
  [[ $first == "$second" ]] || {
    diff "$tmp/first" "$tmp/second" >&2 || true
    fail "the listing changed between the two loads"
  }
  ok "loaded twice in a throw-away namespace, same listing"

  tables=$(nft list tables)
  [[ $tables == "table inet mjk" ]] || fail "after the load the namespace holds: $tables"
  ok "the namespace holds only table inet mjk"

  # Shape of what was loaded (the listing, not the source).
  grep -Eq 'chain forward \{' "$tmp/first" || fail "no chain forward"
  grep -Eq 'type filter hook forward priority filter - 10; policy accept;' "$tmp/first" ||
    fail "chain forward is not a forward-hook base chain with policy accept"
  grep -Eq 'type filter hook input priority filter - 10; policy accept;' "$tmp/first" ||
    fail "chain input is not an input-hook base chain with policy accept"
  [[ $(grep -c 'hook ' "$tmp/first") == 2 ]] || fail "expected exactly two base chains"
  for set in cf4 cf_tunnel4 resolvers4 worker_dst4 private4 dns_nets4; do
    grep -Eq "^[[:space:]]*set $set \{" "$tmp/first" || fail "no set $set"
  done
  # Every jump into the filter chains is keyed on an mjk-* interface.
  local jumps unkeyed last
  jumps=$(grep -E '(goto|jump) ' "$tmp/first" || true)
  unkeyed=$(grep -Ev '(iifname|oifname) "mjk-\*"' <<<"$jumps" || true)
  [[ -n $jumps && -z $unkeyed ]] || fail "a jump or goto that is not keyed on an mjk-* interface: $unkeyed"
  # The last rule of the egress and ingress chains is a drop.
  for chain in egress ingress; do
    last=$(awk -v c="chain $chain {" 'index($0, c) {f = 1; next} f && $0 == "\t}" {print prev; exit} f && NF {prev = $0}' "$tmp/first")
    [[ $last =~ [[:space:]]drop([[:space:]]comment[[:space:]]|$) ]] || fail "chain $chain does not end in a drop: $last"
  done
  ok "two base chains (forward, input), the six sets, jumps keyed on mjk-*, egress and ingress end in a drop"

  # Every accept of the egress chain names a source and a destination set, and the pairs are exactly
  # these: no network reaches an arbitrary public address, the worker's tcp/443 only cf4 and worker_dst4.
  local accepts pairs expected
  accepts=$(awk 'index($0, "chain egress {") {f = 1; next} f && $0 == "\t}" {exit} f' "$tmp/first" |
    sed -E 's/ comment "[^"]*"$//' | grep -E '[[:space:]]accept$' || true)
  pairs=$(sed -nE 's/^[[:space:]]*ip saddr ([^ ]+) ip daddr (@[a-z0-9_]+) .*accept$/\1 \2/p' <<<"$accepts" | sort)
  [[ $(grep -c . <<<"$accepts") == $(grep -c . <<<"$pairs") ]] ||
    fail "an accept of chain egress names no source and destination set: $accepts"
  expected=$(printf '%s\n' '10.63.3.0/24 @cf4' '10.63.3.0/24 @worker_dst4' '10.63.4.0/24 @cf4' \
    '10.63.5.0/24 @cf_tunnel4' '10.63.8.0/24 @cf4' '@dns_nets4 @resolvers4' | sort)
  [[ $pairs == "$expected" ]] || fail "the accepts of chain egress are, as source and destination: $pairs"
  ok "every accept of chain egress is a known source and destination set; the worker's tcp/443 goes to cf4 or worker_dst4 only"

  # mjk-resolvers: a resolv.conf with loopback, IPv6, a malformed and two good resolvers (one twice).
  cat >"$tmp/resolv.conf" <<'EOF'
# a comment
nameserver 127.0.0.53
nameserver ::1
nameserver 2001:db8::53
nameserver 192.0.2.53
nameserver 010.1.2.3
nameserver 256.1.2.3
nameserver 9.9.9.9
nameserver 192.0.2.53
search example.test
EOF
  "$RESOLVERS" "$tmp/resolv.conf" >/dev/null || fail "mjk-resolvers on a resolv.conf with two good resolvers"
  local got
  got=$(nft list set inet mjk resolvers4 | tr -d '\n\t ' | sed -E 's/.*elements=\{([^}]*)\}.*/\1/')
  [[ $got == "192.0.2.53,9.9.9.9" || $got == "9.9.9.9,192.0.2.53" ]] ||
    fail "resolvers4 holds '$got', expected 192.0.2.53 and 9.9.9.9"
  # A second run replaces the set (no stale address stays behind).
  printf 'nameserver 192.0.2.54\n' >"$tmp/resolv2.conf"
  "$RESOLVERS" "$tmp/resolv2.conf" >/dev/null || fail "mjk-resolvers second run"
  got=$(nft list set inet mjk resolvers4 | tr -d '\n\t ' | sed -E 's/.*elements=\{([^}]*)\}.*/\1/')
  [[ $got == "192.0.2.54" ]] || fail "after the second run resolvers4 holds '$got', expected 192.0.2.54"
  ok "mjk-resolvers fills resolvers4 (IPv4 only, no loopback, no malformed, no duplicates) and replaces it"

  printf 'nameserver 127.0.0.53\nnameserver ::1\n' >"$tmp/loopback.conf"
  if "$RESOLVERS" "$tmp/loopback.conf" >/dev/null 2>&1; then fail "mjk-resolvers accepted a loopback-only resolv.conf"; fi
  got=$(nft list set inet mjk resolvers4 | tr -d '\n\t ' | sed -E 's/.*elements=\{([^}]*)\}.*/\1/')
  [[ $got == "192.0.2.54" ]] || fail "a refused run changed resolvers4 to '$got'"
  ok "mjk-resolvers refuses a loopback-only resolv.conf and leaves the set as it was"

  # mjk-egress, with its list under MJK_ROOT: literal addresses (no lookup) and a reserved .invalid name,
  # which no resolver knows (RFC 6761) and which cannot leave this namespace (it has no network).
  local eroot=$tmp/egress list=$tmp/egress/etc/mjk/egress-hosts rc out bad
  mkdir -p "$eroot/etc/mjk"
  run_egress() {
    rc=0
    out=$(MJK_ROOT=$eroot "$EGRESS" 2>&1) || rc=$?
  }
  printf '# the hosts (test)\n\n9.9.9.9\n149.112.112.112   # a trailing comment\n9.9.9.9\n' >"$list"
  run_egress
  ((rc == 0)) || fail "mjk-egress with every host resolved exited $rc: $out"
  got=$(elements worker_dst4)
  [[ $got == "149.112.112.112,9.9.9.9" ]] || fail "worker_dst4 holds '$got', expected 149.112.112.112 and 9.9.9.9"
  [[ $out != *9.9.9.9* && $out != *149.112* ]] || fail "mjk-egress printed an address: $out"
  ok "mjk-egress fills worker_dst4 (comments, blank lines and duplicates skipped) and prints counts only"

  # Hosts with no address (an unresolvable name, a private literal): add only, nothing removed.
  printf '9.9.9.10\nmjk-egress-check.invalid\n10.1.2.3\n' >"$list"
  run_egress
  ((rc == 75)) || fail "mjk-egress with two hosts unresolved exited $rc, not 75: $out"
  got=$(elements worker_dst4)
  [[ $got == "149.112.112.112,9.9.9.10,9.9.9.9" ]] ||
    fail "after a partial run worker_dst4 holds '$got', expected the old two plus 9.9.9.10 (and no private address)"
  [[ $out == *"line(s) 2 3"* ]] || fail "mjk-egress did not name the unresolved lines: $out"
  ok "with a host unresolved mjk-egress only adds (exit 75): the old addresses stay, a private one is never added"

  # Every host resolved again: the set is replaced and the stale addresses go.
  printf '9.9.9.11\n' >"$list"
  run_egress
  ((rc == 0)) || fail "mjk-egress after the partial run exited $rc: $out"
  got=$(elements worker_dst4)
  [[ $got == "9.9.9.11" ]] || fail "after a full run worker_dst4 holds '$got', expected 9.9.9.11 alone"
  ok "the next run where every host resolves replaces worker_dst4 (flush and add in one transaction)"

  # No host with an address; an empty, malformed or missing list: exit 1, the set as it was.
  for bad in 'mjk-egress-check.invalid\n192.0.2.10\n' '# only a comment\n\n' '010.1.2.3\n' '9.9.9.12 9.9.9.13\n' \
    'Query.Wikidata.org\n' 'bad_name.example\n' '-x.example\n' 'example\n' '9.9.9.12\nnot a host\n' missing; do
    if [[ $bad == missing ]]; then rm -f "$list"; else printf '%b' "$bad" >"$list"; fi
    run_egress
    ((rc == 1)) || fail "mjk-egress with the list '$bad' exited $rc, not 1: $out"
    got=$(elements worker_dst4)
    [[ $got == "9.9.9.11" ]] || fail "mjk-egress with the list '$bad' changed worker_dst4 to '$got'"
  done
  ok "mjk-egress changes nothing and exits 1 when no host resolves or the list is empty, malformed or missing"

  # A reload empties the sets again: mjk-firewall.service (resolvers4), mjk-egress.service (worker_dst4) and
  # mjk-tick (both) refill them after every load.
  nft -f "$NFT_FILE"
  for set in resolvers4 worker_dst4; do
    got=$(nft list set inet mjk "$set")
    [[ $got != *elements* ]] || fail "a reload kept $set's elements"
  done
  ok "a reload empties resolvers4 and worker_dst4 (mjk-firewall.service, mjk-egress.service and mjk-tick refill them)"

  nft delete table inet mjk
  if "$RESOLVERS" "$tmp/resolv.conf" >/dev/null 2>&1; then fail "mjk-resolvers succeeded without the table"; fi
  printf '9.9.9.9\n' >"$list"
  run_egress
  ((rc == 1)) || fail "mjk-egress without the table exited $rc, not 1: $out"
  ok "mjk-resolvers and mjk-egress fail when table inet mjk is not loaded"
}

if [[ ${1:-} == --in-netns ]]; then
  in_netns
  exit 0
fi
(($# == 0)) || fail "usage: deploy/tests/nft-check.sh"

# --- 1. Nothing under deploy/ empties the whole ruleset ----------------------------------------------------
# The pattern is built in two halves so that this file does not match itself.
word=rule
pattern="flush[[:space:]]+${word}set"
if hits=$(grep -rnIiE "$pattern" "$ROOT/deploy"); then
  echo "$hits" >&2
  fail "a statement that empties the whole ruleset under deploy/"
fi
ok "no statement under deploy/ empties the whole ruleset"

# --- 2. mjk.nft names only table inet mjk -----------------------------------------------------------------
[[ -f $NFT_FILE ]] || fail "missing $NFT_FILE"
# Tokens of the file without # comments and without "..." strings (a comment may hold any word).
tokens=$(awk '
  {
    out = ""; q = 0
    for (i = 1; i <= length($0); i++) {
      ch = substr($0, i, 1)
      if (ch == "\"") { q = !q; continue }
      if (q) continue
      if (ch == "#") break
      out = out ch
    }
    gsub(/[{};]/, " ", out)
    n = split(out, t, /[[:space:]]+/)
    for (j = 1; j <= n; j++) if (t[j] != "") print t[j]
  }' "$NFT_FILE")
mapfile -t tok <<<"$tokens"
tables=0
for ((i = 0; i < ${#tok[@]}; i++)); do
  case ${tok[i]} in
    table)
      [[ ${tok[i + 1]:-} == inet && ${tok[i + 2]:-} == mjk ]] ||
        fail "mjk.nft names a table other than inet mjk: table ${tok[i + 1]:-} ${tok[i + 2]:-}"
      tables=$((tables + 1))
      ;;
    include) fail "mjk.nft includes another file" ;;
    ruleset) fail "mjk.nft names the whole ruleset" ;;
  esac
done
((tables > 0)) || fail "mjk.nft defines no table"
ok "mjk.nft names only table inet mjk ($tables statements), includes nothing, never names the ruleset"

# --- 3 and 4 need nft and privileges -----------------------------------------------------------------------
if ! command -v nft >/dev/null 2>&1; then
  skip "nft is not installed: nft -c and the namespace load were not run"
  exit 0
fi
if ! command -v unshare >/dev/null 2>&1; then
  skip "unshare is not installed: nft -c and the namespace load were not run"
  exit 0
fi
if ((EUID == 0)) && unshare -n true 2>/dev/null; then
  ns=(unshare -n)
elif unshare -r -n true 2>/dev/null; then
  ns=(unshare -r -n)
else
  skip "neither root nor an unprivileged user namespace: nft -c and the namespace load were not run"
  exit 0
fi

# nft -c checks against the kernel without changing anything; it runs in the new namespace as well, so it
# also works without root.
"${ns[@]}" -- nft -c -f "$NFT_FILE" || fail "nft -c -f $NFT_FILE"
ok "nft -c -f accepts mjk.nft"

MJK_NFT_CHECK_PARENT_NS=$(readlink /proc/self/ns/net)
export MJK_NFT_CHECK_PARENT_NS
"${ns[@]}" -- bash "$SELF" --in-netns || fail "the namespace checks"
ok "all checks passed"
