import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { Session } from '../../auth/session.ts';
import type { Logger } from '../../lib/log.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import type { AccessIdentity } from './access-jwt.ts';
import type { ClientAddress } from './client-address.ts';

// The first middleware (A§14 "Request logs", invariant 8): a request id, then one log line per
// request with the method, the route pattern, the status, the duration and the id. Never the raw
// path or query (a near-me query holds coordinates), a header, an address or a body: of the body only
// how it was framed, as a fixed code.

export type ApiEnv = {
  Variables: {
    requestId: string;
    /** Set by the client-address middleware (runApi only); never logged. */
    client?: ClientAddress;
    /** Set only for a valid Access JWT on the admin host (runApi only). */
    access?: AccessIdentity;
    /** Set by readJson when the bytes read differ from the Content-Length (logged as a code). */
    bodyMismatch?: boolean;
    /** The signed-in session on this host (the session middleware; only on auth, me and admin paths). */
    session?: Session;
    /** On the admin host: a live session whose user's email differs from the Access JWT's (→ 403 at the admin gate). */
    adminMismatch?: boolean;
  };
};

/**
 * How the request framed its body, as one fixed code for the request log (A§14's tunnel check):
 * `chunked` (a Transfer-Encoding), `length` (a Content-Length over 0), `none`, or `mismatch`
 * (readJson read another number of bytes). Never the content or the length itself.
 */
function bodyKind(c: Context<ApiEnv>): 'none' | 'length' | 'chunked' | 'mismatch' {
  if (c.get('bodyMismatch') === true) return 'mismatch';
  if (c.req.header('transfer-encoding') !== undefined) return 'chunked';
  const length = c.req.header('content-length');
  return length !== undefined && length.trim() !== '0' ? 'length' : 'none';
}

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
        body: bodyKind(c),
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  };
}
