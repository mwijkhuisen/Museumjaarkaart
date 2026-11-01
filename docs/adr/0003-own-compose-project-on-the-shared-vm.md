# ADR-0003: Own compose project `mjk` on the shared VM

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The site runs on the Hyper-V VM that already hosts Waterheight (`rws`) and F1 Timings (`f1`): Debian 13 amd64, 6 vCPU / 12 GB today (D11).
- Each existing nftables table filters only its own bridges (`rws-*` and `docker0`; `f1-*`), so a third project's egress is unrestricted by default.
- F1 ADR-0003 proved the pattern: its own compose project, Postgres, bridges, table, IDs, paths and timers.
- This project adds load F1 does not have: photo processing with sharp, uploads into a quarantine directory, and ~50 GB of originals in year one [U] (A§17.1).

## Decision

- Compose project **`mjk`** with its own PostgreSQL 18.6 container and volume `mjk_pgdata`. Paths `/etc/mjk/{mjk.env,secrets/}` and `/srv/mjk/{state,originals,quarantine,exports,tiles-build,backup-staging}` (A§17.1).
- Its own bridges, IPv4 only, with fixed subnets from `10.63.1.0/24` in this order: `mjk-db`, `mjk-edge`, `mjk-egress`, `mjk-api-egress`, `mjk-tunnel`, `mjk-tunnel-edge`, `mjk-publish`, `mjk-backup-egress`. F1 uses 10.62.x, Waterheight 172.30.0.0/16. `deploy/bin/mjk-install` refuses to install when one overlaps a host route or a non-`mjk` Docker network.
- Its own `table inet mjk`, loaded by `mjk-firewall.service` (`nft -c`, then `nft -f`; never `flush ruleset`). Forward hook on `mjk-*` interfaces only; DNS only from the egress networks to `resolvers4`; egress per network as in A§17.4 (`ssr` has none).
- Containers run as UID **63532** (F1 62532, Waterheight 65532/65533). Secret GIDs start at **63001** (`db_postgres` 63001 … `hc_ping_key` 63013; 63014 and up reserved for P7), where F1 uses 62001+ and Waterheight 61001–61012.
- Only `caddy` publishes a port: `127.0.0.1:8280`, for the update smoke test (F1 8180, Waterheight 80).
- Its own timers, `mjk-update` (10 min), `mjk-tick` (10 min, at :07) and `mjk-backup` (nightly), and its own healthchecks (owner action A8).
- **VM resize** to 8 vCPU / 16 GB, proposed as owner action A3 before P1e [U: measured after P1e and after the beta].

## Consequences

- An `mjk` bug, upgrade, migration or upload flood cannot touch the data or uptime of `rws` or `f1`. P1e checks it with `docker compose -p rws ps` and `docker compose -p f1 ps` before and after the install.
- Its own Postgres costs ~1 GB more RAM than sharing one [U]. Limits per service are in A§17.2 [U].
- Host-level settings (`daemon.json`, sysctl, apt) stay Waterheight's; the `mjk` install only reads them.
- Nothing in `mjk` reads or writes `/etc/rws`, `/srv/rws`, `/etc/f1` or `/srv/f1` (A§16.1).
- Three projects share one machine, one disk and one home line: a single failure domain (A§20). Off-site backups cover the data (ADR-0011), not the uptime.

## Alternatives rejected

- **Waterheight's or F1's Postgres with a separate database:** couples upgrades, backups and connection limits across projects.
- **A separate VM or VPS:** more cost and ops, while the hardware exists (D11).
- **SQLite:** breaks the Kysely + pg stack, and search, jobs and rate limits rely on PostgreSQL (ADR-0015).
- **Sharing F1's or Waterheight's networks, table or GIDs:** one project's firewall change or secret would reach the others.
