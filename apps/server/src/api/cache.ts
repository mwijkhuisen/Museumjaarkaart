// Cache-Control per answer (A§14). The api sets it on every answer; Caddy passes it through on /api/*.
// The s-maxage values are [U P5a]: Cloudflare caches JSON only through the Cache Rules of A§17.7.

/** A public GET: the same bytes for everyone, briefly at the edge. */
export const CACHE_PUBLIC = 'public, max-age=0, s-maxage=60';
/** A 301 from an old slug: longer at the edge, never in the browser (a slug can be taken back). */
export const CACHE_REDIRECT = 'public, max-age=0, s-maxage=3600';
/** Anything personal or positional (near-me), and every 4xx and 5xx. */
export const CACHE_PRIVATE = 'private, no-store';
/** healthz. */
export const CACHE_NONE = 'no-store';
