# Research: accounts, authentication and email

Research input (2026-11-01). Superseded by ARCHITECTURE.md where they differ.

Sub-agent report. Versions, dates, licences and maintainers come from registry.npmjs.org on 2026-11-01; transitive counts from `npm install --package-lock-only` in a scratch directory. Outcome: D8, D15, A§9, ADR-0007, ADR-0012. The plan differs: email + password is in from P2a (the report put it later), no social login at all, IPv6 keyed by /56 and its /48 at 4× [U] rather than /64, and CSRF by our own Origin/`Sec-Fetch-Site` middleware rather than Hono's `csrf()`; the client IP comes from Caddy's `X-Mjk-Client` (right-most untrusted `X-Forwarded-For`), never `CF-Connecting-IP`; the cookie is `__Host-mjk_sid`.

## 1. Libraries

| Package | Version | Licence | Notes |
|---|---|---|---|
| better-auth | 1.7.15 (published 2026-11-01); newest past the 7-day rule **1.7.13** (2026-10-25) | MIT | See below |
| Lucia | deprecated March 2025 | – | Site (updated July 2026) now points to one file, `code/auth_session.ts`, plus the Auth Book (https://lucia-auth.com/). @oslojs/encoding 1.1.0 and @oslojs/crypto 1.0.1 unchanged since September 2024 |
| arctic (OAuth clients) | 3.7.0 | MIT | 7 packages, last release May 2025, one maintainer |
| @simplewebauthn/server | 14.0.3 (2026-09-25) | MIT | Node ≥ 20, one maintainer, 25 packages (mostly @peculiar/asn1 + reflect-metadata). Browser package 14.0.0 |
| @node-rs/argon2 | 2.2.2 | – | Prebuilt NAPI binaries per platform; would run on glibc distroless, but an extra binary for no gain |
| hash-wasm | 4.12.0 | – | No release since November 2024 |
| Auth.js | – | – | Run by the Better Auth team since 2025-09-22, which tells new projects to use Better Auth (https://www.better-auth.com/blog/authjs-joins-better-auth). Skip |

- **better-auth details:**
  - Takes an existing Kysely instance (`database: { db, type: "postgres" }`) and mounts with `app.all("/api/auth/*", c => auth.handler(c.req.raw))` (https://www.better-auth.com/docs/adapters/postgresql, https://www.better-auth.com/docs/integrations/hono).
  - Plugins: passkey, magic link, email OTP, 2FA, admin (roles, `banUser` with `banExpiresIn`, session revocation); `deleteUser` with email confirmation; `requireEmailVerification` (https://www.better-auth.com/docs/plugins/admin, https://www.better-auth.com/docs/concepts/users-accounts, https://www.better-auth.com/docs/concepts/email).
  - Rate limiter built in: reads `ipAddressHeaders: ["cf-connecting-ip"]`, groups IPv6 by /64, memory storage by default, database optional (https://www.better-auth.com/docs/concepts/rate-limit). Telemetry off by default (https://www.better-auth.com/docs/reference/telemetry).
  - Dependencies: better-auth + kysely + pg = 35 packages, against 15 for kysely + pg; the extra ~20 include unused mongo, prisma and drizzle adapters and a telemetry package.
  - Health: one npm publisher; a $5M seed in June 2025 (https://better-auth.com/blog/seed-round).
  - Release churn: 11 stable releases between 2026-09-14 and 2026-11-01, so the 7-day rule always runs behind fixes.
  - Pin conflict: `@better-auth/passkey@1.7.12` with `better-auth@1.7.12` failed with ERESOLVE (exact peer pin on @better-fetch/fetch), reproduced locally.
  - Advisories: ~13 in third-party mirrors (https://corgea.com/advisories/packages/npm/better-auth). 2026 ones: a session counted valid before 2FA was finished (https://advisories.gitlab.com/npm/better-auth/GHSA-xg6x-h9c9-2m83/); an OAuth state mismatch fixed in 1.6.2 (https://vulnerability.circl.lu/vuln/GHSA-WXW3-Q3M9-C3JR); a rate-limit bypass by rotating IPv6 addresses (CVE-2026-45364).
- **Password hashing:** Node 26 has `crypto.argon2()` built in (added in v24.7.0, no stability flag in the v26 docs: https://nodejs.org/docs/latest-v26.x/api/crypto.json): argon2id with no dependency and no native addon. `scrypt` in `node:crypto` is the fallback.
- **Own code vs better-auth:**
  - Own: a `session` table whose id is sha256 of the token; cookie `__Host-sid; HttpOnly; Secure; SameSite=Lax`. CSRF: SameSite=Lax + Hono's `csrf()` (checks Origin and Sec-Fetch-Site on form content types: https://hono.dev/docs/middleware/builtin/csrf) + a JSON-only API. Estimate ~800 lines plus tests [U].
  - better-auth saves building admin, 2FA and deletion, but brings its own schema, a larger attack surface and constant releases.

## 2. Login methods under a strict CSP

- **OAuth** is a top-level navigation, so it fits if we draw our own buttons and load no Google or Apple scripts. Start it with a GET link: a form POST that redirects off-site can be blocked by `form-action 'self'` [U per browser]. Apple returns a cross-site `form_post`, so its state cookie needs `SameSite=None` and that route a CSRF exemption (https://v1.arcticjs.dev/providers/apple).
- **Magic links** can be used up by mail scanners that open links [U]. A 6-digit code is safer.
- **Passkeys** make no third-party requests; the browser library is bundled with our code.
- **Bot protection without third-party scripts:**
  - Cloudflare Free allows 1 rate-limiting rule with a 10-second period (https://blog.cloudflare.com/unmetered-ratelimiting/): use it on the auth routes.
  - **altcha-lib 2.8.0** (no dependencies, MIT, Hono peer) with the **altcha 3.5.0** widget; its `/dist/external` build keeps `worker-src 'self'` enough (https://github.com/altcha-org/altcha).
  - Cap (Apache-2.0) is the alternative but needs its own container (https://github.com/tiagozip/cap).
  - A honeypot field.

## 3. Transactional email (~1–5k emails a month)

| Provider | Price | Data location | Notes |
|---|---|---|---|
| **Lettermint** (NL) | Free 300/month (hard cap); Starter €10/month for 10k | EU only | API and SMTP on every plan (https://lettermint.co/pricing). The API resolves to 2 fixed IPs today, which suits an nftables allowlist |
| Scaleway TEM (FR) | 300 free, then €0.25 per 1,000 (~€1/month) | EU | Default quota 10k/month (https://www.scaleway.com/en/transactional-email-tem/) |
| Postmark | $15 for 10k | Not stated; a competitor says US only [U] | https://postmarkapp.com/pricing |
| Mailgun EU | ~$15 for 10k | Account data replicated globally per third parties [U] | |
| Resend | – | EU sending region, but account data and logs reportedly in the US [U] | https://nuntly.com/alternatives/resend-eu |
| Amazon SES | $0.10 per 1,000 | – | 2026 plan changes unclear [U]; large, changing IP ranges make an egress allowlist hard |
| Brevo | Free 300/day with branding [U] | – | |

- **Set-up:** call the provider's HTTPS API with plain `fetch`. The `lettermint` SDK (3.3.0) was 2 days old, so it fails the 7-day rule. SPF include, DKIM and DMARC (start at `p=none`) in Cloudflare DNS.

## 4. Abuse controls

- `email_verified_at` must be set before any review or upload.
- Rate limits at two layers: the Cloudflare edge rule, plus a Postgres limiter keyed by user id and `CF-Connecting-IP` (IPv6 grouped). Trust that header only on requests that came through cloudflared → Caddy (https://developers.cloudflare.com/fundamentals/reference/http-headers/).
- Role enum `user | moderator | admin`, plus `banned_until` and `ban_reason`; a ban revokes all of the user's sessions.
- Self-service deletion after a fresh code check: deletes sessions and media and either anonymises or deletes the user's reviews.

## 5. Recommendation

Own auth code on Lucia's `auth_session.ts` approach, with Kysely and dbmate.
- First release: email + 6-digit code (doubles as email verification, no stored passwords).
- Phase 2: passkeys with `@simplewebauthn/server@14.0.3` and `@simplewebauthn/browser@14.0.0`.
- Optional: Google sign-in with `arctic@3.7.0`.
- Bot protection: `altcha-lib@2.8.0` + `altcha@3.5.0`.
- Passwords, if added: argon2id through `node:crypto`.
- Email: Lettermint via plain `fetch`.
- Why: the core needs no new dependencies, keeps CSP and egress tight, and avoids better-auth's churn and advisory history. Fallback: `better-auth@1.7.13` if 2FA and admin tooling are wanted at once.

Questions it raised (answered in the interview, A§3): passwords at all · which social logins (Apple needs a paid developer account [U fee]) · 2FA for moderators and admins · Lettermint or Scaleway · anonymise or delete reviews on deletion · minimum age and terms acceptance · display names or real names, public profiles · who moderates, before or after publication.
