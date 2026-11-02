import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { Logger } from '../../lib/log.ts';
import { CACHE_PRIVATE } from '../cache.ts';

// The first middleware (A§14 "Request logs", invariant 8): a request id, then one log line per
// request with the method, the route pattern, the status, the duration and the id. Never the raw
// path or query (a near-me query holds coordinates), a header, an address or a body.

export type ApiEnv = { Variables: { requestId: string } };

const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** How Hono 4.13 lists a global `app.use('*', …)` middleware among the matched routes. */
const GLOBAL = new Set(['*', '/*']);

/**
 * The pattern of the route that answers: the first matched route that is not a global middleware
 * (the router lists routes in registration order, and the first registered one answers), or
 * `unmatched`. Never derived from the request path.
 */
export function routePattern(c: Context): string {
  return matchedRoutes(c).find((r) => !GLOBAL.has(r.path))?.path ?? 'unmatched';
}

export function requestLog(logger: Logger): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const started = performance.now();
    // Always our own id: a client-chosen X-Request-Id would let a client write into the log.
    const id = randomUUID();
    c.set('requestId', id);
    await next();
    c.res.headers.set('X-Request-Id', id);
    // Every 4xx and 5xx is private, no-store (A§14), whatever built it.
    if (c.res.status >= 400) c.res.headers.set('Cache-Control', CACHE_PRIVATE);
    logger.info(
      {
        req: id,
        method: METHODS.has(c.req.method) ? c.req.method : 'other',
        route: routePattern(c),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  };
}
