import type { MiddlewareHandler } from 'hono';
import { respondError } from '../errors.ts';
import type { ApiEnv } from './request.ts';

// The 64 KB body cap (A§14). It reads only the request headers and never touches `c.req.raw`:
// with `overrideGlobalObjects: false` (server.ts), `c.req.raw` is @hono/node-server's own request
// object, and Hono's `bodyLimit` does `new Request(c.req.raw, …)` for a body without a usable
// Content-Length, which throws there (a 500 for every bodyless DELETE or OPTIONS and every chunked
// request; socket.int.test.ts proves the fix over a real socket).
//
//   - Content-Length over the cap → 413 `too_large`; one that is not a plain decimal → 400.
//   - Transfer-Encoding (a body of unknown length) → 400 `bad_request` with `fields: []`.
//
// No route reads a body before P2a. P2a revisits this with its JSON routes (and P3b with its 8 MiB
// upload chunks): a route that reads a body then counts the bytes it reads as well.

/** The header-only body cap. Never reads the body. */
export function bodyCap(maxBytes: number): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
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
