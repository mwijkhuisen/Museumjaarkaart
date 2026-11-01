# ADR-0012: Transactional email via Lettermint

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)
- **Revisit:** before public launch (P5a), or when the free plan's cap comes in sight.

## Context

- The site sends sign-in and sign-up codes, invites, notice receipts, moderation decisions (statements of reasons) and "export ready" mails: ~1–5k a month after launch [U].
- The processor should be in the EU with a DPA (A§13.2), and its API should be easy to allow in an egress firewall.
- Research, 2026-11-01 (`docs/plan/research/auth.md`):
  - **Lettermint** (NL): processes and stores data in the EU only. Free plan 300 a month with a hard cap; Starter €10 a month for 10k; API and SMTP on every plan. The API resolved to 2 fixed IPs [U]. Its SDK (3.3.0) was 2 days old, under the 7-day rule.
  - **Scaleway TEM** (FR): 300 free, then €0.25 per 1,000.
  - **Postmark:** $15 for 10k; data location not stated, reportedly US-only [U].
  - **Mailgun EU:** account data replicated globally [U].
  - **Resend:** an EU sending region, but account data and logs in the US [U].
  - **Amazon SES:** $0.10 per 1,000; large, changing IP ranges; its 2026 plan changes are unclear [U].

## Decision

- **Lettermint** (D15), called with plain `fetch` from the worker's job queue (ADR-0015); no SDK. The token `lettermint_api_token` (GID 63008) is the worker's only.
- The free plan (300 a month) during the beta; Starter (€10 a month) at public launch.
- SPF, DKIM and DMARC (`p=none`, then `quarantine`) in Cloudflare DNS: owner action A4, before P2a.
- A `Mailer` interface with a fake for unit tests and a mail sink in e2e; CI never calls Lettermint (A§18).
- Codes, never links, for sign-in (ADR-0007). Templates in NL and EN by the member's `locale` (ADR-0013). No open or click tracking (A§2): turned off in A4, and P2a checks a delivered mail for a tracking pixel or a rewritten link. The owner accepts Lettermint's DPA in A4; P3d lists it in `docs/legal/processors.md` (A§13.2).

## Consequences

- The free plan's hard cap (300 a month) bounds the beta (codes × members) [U]. Burning it would stop every sign-in code until the month ends, so a mail budget guards it (A§17.7):
  - sign-in codes always go first; mails triggered by anonymous requests (notice receipts, sign-up codes) are capped at 20 a day [U]: over that, `/auth/signup` answers 429 with `Retry-After` (a queued code would expire unsent) and notice receipts wait
  - `/auth/code` sends nothing for an email without an account (A§9), and a notice receipt holds the notice's reference and the target link, never the text or name the notifier typed, so nobody can relay text through our domain
  - the status panel shows the month's count against `MJK_MAIL_CAP`; at 80 % the worker logs `mail_cap_near` and its health ping fails, and the owner moves to Starter before the cap
  - a refused send logs a fixed code.
- Code sign-in depends on delivery; a password or a passkey remains.
- A small vendor: the `Mailer` interface keeps a switch small, with Scaleway TEM as the fallback.
- Worker egress is tcp/443 to the public internet minus private ranges [U narrow to sets later, A§17.4]; Lettermint's fixed IPs would allow narrowing.
- €120 a year from launch (A§19).

## Alternatives rejected

- **Scaleway TEM:** in the EU and cheaper, but the owner chose Lettermint's EU-only processing; it stays the fallback.
- **Postmark:** data location not stated, reportedly US-only [U].
- **Mailgun EU:** account data replicated globally [U].
- **Resend:** account data and logs in the US [U].
- **Amazon SES:** AWS's large, changing IP ranges defeat an egress allowlist.
- **The Lettermint SDK:** failed the 7-day rule, and `fetch` needs no dependency.
