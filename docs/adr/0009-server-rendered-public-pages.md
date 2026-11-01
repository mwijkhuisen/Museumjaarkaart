# ADR-0009: Server-rendered public pages under a strict CSP

- **Status:** Accepted (owner, 2026-11-01)
- **Date:** 2026-11-01
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-11-01)

## Context

- Museum pages, lists, search results, profiles and single reviews are the public face of the site. They must give link previews and be indexed without running JavaScript (D21).
- F1 is a static SPA behind Access. Waterheight is static-first: a publisher writes files, built for flood-time spikes.
- Here content changes on every review, rating and photo, and logged-in views are personal.
- The CSP is F1's and Waterheight's: `script-src 'self'`, no inline scripts or styles; Zod runs `jitless`; React sets styles only through the CSSOM.

## Decision

- **A Vite 8 SSR build** of `apps/web` (`src/entry-server.tsx`, `src/entry-client.tsx`). The `ssr` role (Hono `:8081`) renders public routes with React 19 (`renderToReadableStream` or `prerender` [U P1c]) and embeds the dehydrated TanStack Query state as `<script type="application/json" id="mjk-state">`: a data block that never executes, so `script-src 'self'` allows it. The client calls `hydrateRoot` (A§15.1).
- **Logged-in screens stay an SPA** in the same build. The admin is a separate entry (`admin.html`) on the admin host (ADR-0004).
- **Anonymous only:** `ssr` never reads a session or cookie, logs in as `mjk_ssr` with `SELECT` on the `pub_*` views only (A§8), and has no egress network. Personal bits load client-side from `/api/v1/me` (`private, no-store`).
- **Cacheable public HTML** with a short shared cache at Cloudflare [U `s-maxage`].
- **SEO:** canonical URLs, `hreflang` nl/en (ADR-0013), Open Graph, JSON-LD `Museum`, `sitemap.xml`, `robots.txt`. `X-Robots-Tag: noindex` until P5b (Waterheight's prelaunch profile).
- **The CSP does not loosen** (A§15.6). A build test fails on any inline script or style and on any `data:` or `blob:` source, except `img-src data:` for MapLibre's CSS icons (Waterheight ADR-0016). The `mjk-state` (`application/json`) and JSON-LD (`application/ld+json`) data blocks are the only `<script>` elements without `src`; neither executes, and both are escaped per A§15.1. The "hide ratings until I've visited" fold uses a tiny blocking same-origin script, not an inline one (A§11).
- No router library: a `routeOf` shared by server and client [U P1c].

## Consequences

- One more daemon and a second build output; a hydration mismatch is a bug with a test.
- Crawlers and link previews see the content, and the first paint needs no API round trip.
- Personal data cannot leak through cached HTML: the renderer cannot read private rows and never sees a session.
- A removed review can stay in the edge cache for the `s-maxage`; an urgent removal purges by URL (runbook).

## Alternatives rejected

- **A plain SPA, like F1:** poor link previews and SEO.
- **An SPA with injected meta tags:** previews work, but Google must run JavaScript to see the reviews.
- **A static-first publisher, like Waterheight:** rebuild churn on every review, rating and photo, and personal views cannot be static anyway.
