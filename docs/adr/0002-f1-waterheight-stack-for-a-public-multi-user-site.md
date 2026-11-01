# ADR-0002: The F1/Waterheight stack, adapted for a public multi-user site

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- The owner wants the same kind of stack as F1 Timings (`mwijkhuisen/F1_Timings`) and Waterheight (`mwijkhuisen/Waterheight`): the same agents, workflow and gotchas.
- F1 took Waterheight's stack with lighter ops (F1 ADR-0002): one reader behind Cloudflare Access, no i18n, no map, no backups (all its data can be re-fetched) and no browser tests.
- This site is public and multi-user. It holds accounts and members' visits, reviews and photos, which cannot be re-fetched, and its sign-in, upload and moderation flows only prove themselves in a real browser.
- No D-number of its own (A§3). It collects the stack consequences of D2, D3, D7, D8, D11, D21 and D24.

## Decision

- **Reuse from F1** (pins from F1's `package.json` files, A§4):
  - TypeScript 6.0.3 strict on Node 26.10.0, a pnpm 12.5.1 workspace with the same supply-chain policy, Biome 2.6.2, Vitest 5.0.5 (unit + integration on real PostgreSQL 18), msw 3.0.3, fast-check 4.10.2
  - Hono 4.13.13 + @hono/node-server 2.1.5, Kysely 0.29.7 + pg 8.23.1, dbmate 2.36.0, croner 10.0.1, pino 10.4.0, undici 8.12.3, zod 4.6.7 contracts in `packages/contracts`
  - React 19.3.1, Vite 8.3.5, TanStack Query 5.104.5
  - distroless images, the hardened compose anchor, file secrets with GIDs, `roles.sql`, Caddy, cloudflared, the strict CSP, GHCR digest pulls with rollback
  - the ADR and phase-issue conventions
- **Bring back from Waterheight** (F1 dropped them): Paraglide (ADR-0013); MapLibre and PMTiles (ADR-0014); restic to a locked bucket with a monthly restore drill (ADR-0011); @playwright/test 1.64.1 + @axe-core/playwright 4.14.0 on Chromium and WebKit, with Chainguard MinIO standing in for R2 in CI; the prelaunch `noindex` profile; the privacy page that names Cloudflare first; Caddy trusting only cloudflared's /32 (Waterheight ADR-0021).
- **Drop** (as F1 did): signed pull-based releases (cosign, promote gate), the static-first publisher, brownout, load tests and benches, the owner-audience machinery and WireGuard owner site, the watchdog and public status page, the BOM check, boundary and OpenAPI generators, CodeQL, Lighthouse and `harden-runner`. Also F1's ECharts: v1 has no charts.
- **Add:** accounts, sessions, passkeys and invites (ADR-0007); uploads, the photo pipeline and R2 (ADR-0008); the `ssr` role (ADR-0009); moderation, the DSA flows and the admin host (ADR-0010, ADR-0004); the job queue and search in PostgreSQL (ADR-0015); transactional email (ADR-0012).
- New packages use the versions checked on 2026-11-01 (A§4). **Every pin, shared or new, is re-checked against the 7-day release-age rule when it is installed**, and each new dependency gets an ADR-lite line in its PR.
- **Deploy** as F1: CI pushes `ghcr.io/mwijkhuisen/mjk-server` and `mjk-web` by digest; `mjk-update.timer` pulls, migrates, smoke-tests and rolls back (A§17.5).

## Consequences

- F1's and Waterheight's gotchas carry over to `CLAUDE.md`, plus new ones for SSR, sharp, R2 and auth.
- Supply-chain protection rests on exact pins, the 7-day rule, Dependabot cooldowns, gitleaks, zizmor and GHCR digests, not on signatures. Revisit signed releases if anyone else commits.
- More moving parts than F1: eight server roles (A§5), an e2e compose stack in CI with stand-ins for R2 and Lettermint (A§18), and a backup job with a drill.
- Backups and Playwright return because user content and auth flows exist, not by default.

## Alternatives rejected

- **Waterheight's full stack:** its publisher, brownout and load machinery exist for flood-time spikes, while here content changes on every write (ADR-0009).
- **F1's stack unchanged:** no i18n, map, backups or browser tests, all of which a public multi-user site needs.
