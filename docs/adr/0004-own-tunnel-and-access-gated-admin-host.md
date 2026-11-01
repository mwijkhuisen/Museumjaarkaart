# ADR-0004: Own Cloudflare Tunnel; admin host behind Cloudflare Access

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The VM sits on a home line with no inbound ports; Waterheight and F1 reach the internet through Cloudflare Tunnels.
- Waterheight ADR-0021 fixes that its tunnel carries exactly one public hostname and that its `cloudflared` reaches only Waterheight's `caddy:80`. F1 ADR-0004 gives F1 its own tunnel, with the whole site behind Access.
- This site is public (D1), but moderation and curation must not be reachable with a stolen member session (D22).
- F1 ADR-0004, amended in P1c (2026-10-26): hono 4.13's `hono/jwk` middleware accepts only `Bearer <token>`, while Cloudflare sends the bare JWT in `Cf-Access-Jwt-Assertion`. F1 therefore checks it with its own middleware on hono's `verifyWithJwks`.

## Decision

- **Own tunnel and own `cloudflared`** in the `mjk` project (D11):
  - the token is the file secret `cf_tunnel_token` (GID 63007), read with `--token-file`, never `TUNNEL_TOKEN`; metrics bind to `127.0.0.1:20241`
  - `cloudflared` sits on `mjk-tunnel` (egress tcp+udp/7844 to Cloudflare's tunnel ranges only) and `mjk-tunnel-edge` (internal, shared with `caddy` only), at a fixed address
  - Caddy trusts only that /32 for the client IP (Waterheight ADR-0021 pattern; A§9)
- **Two public hostnames** on the tunnel, both to `caddy:80`: `<domain>` and `admin.<domain>`. `media.<domain>` is not on the tunnel: it is the R2 bucket's custom domain (ADR-0008, ADR-0014).
- **Cloudflare Access on `admin.<domain>` only** (owner action A2): one allow policy for the owner's email, login by one-time PIN, as in F1. The application covers the whole hostname (path `*`), with no Bypass or Everyone policy and a session duration of 24 h [U]. Moderators are added to the policy by email when there are any.
- **The `api` checks the Access JWT itself**, first, on every request whose `Host` is `admin.<domain>`, the auth routes included, with F1's own middleware on hono's `verifyWithJwks` (F1 ADR-0004 amendment): the bare JWT from `Cf-Access-Jwt-Assertion`, RS256 with a `kid`, `iss` and `aud` checked, `exp` required, `nbf` with 60 s of skew, `iat` not checked; certs cached for 5 min and used stale for up to 1 h, then 503. Every refusal is the same 401.
- **Plus the app role** (D22, A§9): an admin-host session (`session.host = admin`) whose user is `moderator` or `admin` and whose email matches the JWT's email. An admin-host session is created only after the JWT check and only for an email equal to the JWT's. Caddy answers `/api/admin/*` on the public host with 404, and the `api` refuses it unless the `Host` is the admin host (A§5).
- **Narrow admin-host routes** (A§5): Caddy forwards only `/api/admin/*`, `/api/v1/auth/*` (except signup), `/api/v1/me*` and `GET /api/v1/museums*` to the `api`; `/assets/*` is served as files; any other `/api/*` is a 404; everything else is the admin SPA.
- `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` are config in `/etc/mjk/mjk.env`, not secrets; if one is missing or malformed the `api` exits 78. The `api` gets egress tcp/443 to Cloudflare's published ranges only (`mjk-api-egress`), for the certs (A§17.4).

## Consequences

- Waterheight's and F1's tunnels, invariants and tests stay untouched.
- A misconfigured Access policy still exposes no admin route and no admin-host session: the `api` answers every admin-host request without a valid JWT with the same 401, and the admin routes also need the role. Sign-up and uploads do not exist on the admin host. A stolen public session carries no JWT, and the host-only `__Host-` cookie never reaches the admin host.
- Cloudflare sees every request; the privacy page names it first (A§13.2).
- Everything through the tunnel is under Cloudflare's 100 MB body cap and timeout, hence chunked uploads (ADR-0008).
- The real `cloudflared` never runs in CI (a stand-in does); it is first proved on the VM in P1e.

## Alternatives rejected

- **An extra hostname on Waterheight's or F1's tunnel:** breaks Waterheight ADR-0021 and F1 ADR-0004, and ties three projects to one token and one connector.
- **Access on the whole site, like F1:** the site is public (D1).
- **The app role alone, without Access:** a stolen session or an auth bug would reach moderation, notices and personal data (D22).
- **Admin over the LAN or WireGuard only:** the owner moderates from anywhere, and Waterheight's owner-site machinery is dropped (ADR-0002).
- **The `hono/jwk` middleware:** it refuses the bare JWT (F1 ADR-0004 amendment).
