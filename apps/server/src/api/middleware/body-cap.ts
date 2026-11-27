import type { Context, MiddlewareHandler } from 'hono';
import { respondError } from '../errors.ts';
import type { ApiEnv } from './request.ts';

// The body cap (A§14): 64 KiB, and 2 MiB for an import's file and its confirm (P2c design 4; the
// limit per request comes from app.ts, which names those two routes). It reads only the request headers and never touches `c.req.raw`:
// with `overrideGlobalObjects: false` (server.ts), `c.req.raw` is @hono/node-server's own request
// object, and Hono's `bodyLimit` does `new Request(c.req.raw, …)` for a body without a usable
// Content-Length, which throws there (a 500 for every bodyless DELETE or OPTIONS and every chunked
// request; socket.int.test.ts proves the fix over a real socket).
//
//   - Content-Length over the cap → 413 `too_large`; one that is not a plain decimal → 400.
//   - Transfer-Encoding (a body of unknown length) → 400 `bad_request` with `fields: []`.
//
// A route that reads a body counts the bytes it reads as well (readJson).

/** The header-only body cap, at `limit(c)` bytes for this request. Never reads the body. */
export function bodyCap(limit: (c: Context<ApiEnv>) => number): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const maxBytes = limit(c);
    if (c.req.header('transfer-encoding') !== undefined) return respondError(c, 'bad_request', []);
    const raw = c.req.header('content-length');
    if (raw !== undefined) {
      const length = raw.trim();
      if (!/^[0-9]+$/.test(length)) return respondError(c, 'bad_request', []);
      if (length.length > 15 || Number(length) > maxBytes) return respondError(c, 'too_large');
    }
    await next();
  };
}
