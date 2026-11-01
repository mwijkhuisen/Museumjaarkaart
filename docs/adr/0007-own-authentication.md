# ADR-0007: Own authentication: email code, password and passkeys

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- Members sign up (by invite during the beta, D1) and sign in from phones and desktops. The browser loads no third-party scripts (A§16.1), and every dependency must pass the 7-day release-age rule.
- Research, 2026-11-01 (`docs/plan/research/auth.md`):
  - **better-auth:** latest 1.7.15 (published that day); the newest version under the rule is 1.7.13. With Kysely and pg it is 35 packages, against 15 without it. 11 stable releases between 2026-09-14 and 2026-11-01. `@better-auth/passkey@1.7.12` with `better-auth@1.7.12` fails with ERESOLVE on an exact peer pin of `@better-fetch/fetch` (reproduced). About 13 advisories on third-party mirrors, 2026 ones among them: a session counted as valid before 2FA finished, an OAuth state mismatch, an IPv6 rate-limit bypass (CVE-2026-45364) [U].
  - **Lucia** was deprecated in March 2025 and is now a reference approach (`auth_session.ts`). **Auth.js** is run by the Better Auth team, which steers new projects to Better Auth.
  - **Node 26** has `crypto.argon2()` (since 24.7.0): argon2id with no dependency and no native addon.
  - **@simplewebauthn/server 14.0.3** (MIT, ~25 packages [U]) and **@simplewebauthn/browser 14.0.0** for passkeys. **altcha-lib 2.8.0** (no dependencies) and the **altcha 3.5.0** widget for bot checks without a third party.

## Decision

- **Own code** (D8) following Lucia's `auth_session` approach (A§9): a 32-byte random token; the `session` row id is sha256(token); cookie `__Host-mjk_sid; HttpOnly; Secure; SameSite=Lax; Path=/`; 30-day sliding expiry, 180 days absolute; admin-host sessions 12 h idle and 7 days absolute [U]; `session.host` is `public` or `admin`. Signing in deletes the row of any session cookie sent with the request and always issues a new token.
- **Sign-in methods:**
  - email + a 6-digit code: stored as an HMAC with a pepper from `app_keys`, valid 10 min, 5 attempts, single use; it doubles as email verification. Issuing a code voids every unused code for the same email and purpose; verify compares only with the newest code and names its purpose (`signin` · `signup` · `email_change` · `delete`). `/auth/code` sends nothing for an email without an account, with the same 202 and timing. The worker mails the code from a `mail_code` job whose payload holds it sealed (AES-256-GCM, the `code_seal` key in `app_keys`) and nulled once sent: the one exception to ids-only job payloads (A§9, ADR-0015)
  - an optional password: argon2id through `node:crypto` `argon2()`, never below OWASP's floor (m = 19 MiB, t = 2, p = 1), with the highest m ≤ 64 MiB that keeps one hash under 250 ms on the VM [U P2a], at most 2 hashes at once per process (a waiter gives up after 2 s with 429); 12 to 256 characters; a hash with older parameters is redone at the next successful sign-in; no HIBP check (a third party), one error for an unknown email or a wrong password, and a dummy hash so the timing matches
  - passkeys (P2b): discoverable credentials, RP ID `<domain>`, challenges single use for 5 min. `userVerification: 'required'` at registration and sign-in, and the server rejects an assertion without the UV flag; `expectedRPID` is `<domain>` and `expectedOrigin` is the origin of the host the request arrived on (`https://<domain>` or `https://admin.<domain>`); a challenge records its host. An email code always remains a way in.
- **Sign-up:** invite code (beta), email, handle, display name, a 16+ confirmation, the terms version, an ALTCHA solution (`/dist/external` build, so `worker-src 'self'` is enough) and a honeypot. The answer is the same whether or not the email has an account; the account exists only once the code is entered.
- **Re-authentication** (A§9): email change, password set/change/remove, passkey add/remove and "sign out other sessions" need a sign-in or code within the last 10 min, else 403 `reauth_required`. Email changes, password changes and passkey removals delete every other session. A member who loses the mailbox signs in with a password or passkey; without either there is no recovery, and the owner never moves an account on request.
- **CSRF:** `SameSite=Lax`, our own Origin/`Sec-Fetch-Site` middleware on every unsafe method (A§14; hono's `csrf()` checks only form content types [U]) and JSON-only mutations (anything else gets 415).
- **Abuse:** a Postgres rate limiter keyed by user id, email and IP prefix (/24 IPv4; /56 IPv6, and its /48 at 4× the limit [U]): code requests 3 per 15 min per (email, IP prefix) and 20 a day per email; 30 failed code checks an hour per IP prefix; above 500 failures an hour site-wide, verify also needs an ALTCHA solution [U] (A§9). Plus one Cloudflare rate-limiting rule on `/api/v1/auth/*` (owner action A2). The client IP comes from Caddy, which trusts only cloudflared's /32 (ADR-0004).
- **Roles** `user` · `moderator` · `admin`; a ban revokes every session. The admin host also needs Access (ADR-0004).
- No Google or Apple sign-in (D8). Pins are re-checked against the 7-day rule when installed.

## Consequences

- We own ~800 lines plus tests [U]; P2a and P2b carry `review:security`.
- P2a adds one server dependency (`altcha-lib`) and the widget; passkeys add `@simplewebauthn` in P2b, each with an ADR-lite line.
- Code sign-in depends on mail delivery (ADR-0012); a password or a passkey is the alternative.
- No TOTP 2FA. A passkey is the strong option, and moderators also sit behind Access.

## Alternatives rejected

- **better-auth 1.7.x:** 35 packages, release churn that always runs ahead of the 7-day rule, ~13 advisories including 2026 ones [U], and an ERESOLVE on its exact peer pin.
- **Auth.js:** folded into Better Auth.
- **Magic links:** mail scanners open links and use them up [U]; a code survives that.
- **Google and Apple sign-in:** not wanted (D8). Apple also needs a paid developer account [U fee] and a cross-site `form_post` that needs `SameSite=None` and a CSRF exemption.
- **@node-rs/argon2:** an extra native binary for no gain over `node:crypto`.
