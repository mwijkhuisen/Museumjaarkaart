import { AdminMe } from '@mjk/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import { CACHE_PRIVATE } from './cache.ts';
import { respondError } from './errors.ts';
import { isAdminHost } from './middleware/access-jwt.ts';
import type { SiteDeps } from './middleware/csrf.ts';
import type { ApiEnv } from './middleware/request.ts';
import { sendJson } from './respond.ts';

// The admin host's gate (D22, ADR-0004, A§9, A§14). By the time a request gets here:
//   - accessJwt has refused every admin-host request without a valid Access JWT (401), the auth
//     routes included, and buildApp has answered `/api/admin/*` with 404 on any other host;
//   - the session middleware has kept a session only when it belongs to this host and its user's
//     email equals the JWT's (else `adminMismatch`).
// `/api/admin/*` then needs that session (401 without one; 403 for another email than the JWT's)
// and the role `moderator` or `admin` (else 403). Every admin answer is private, no-store.

export function adminRoutes(): Hono<ApiEnv> {
  const admin = new Hono<ApiEnv>();
  admin.use('*', async (c, next) => {
    const session = c.get('session');
    if (session === undefined) return respondError(c, c.get('adminMismatch') === true ? 'forbidden' : 'unauthorized');
    if (session.host !== 'admin') return respondError(c, 'unauthorized');
    if (session.user.role !== 'moderator' && session.user.role !== 'admin') return respondError(c, 'forbidden');
    await next();
  });
  // The smallest admin route (A§14): who is signed in on the admin host. The admin SPA's sign-in uses it.
  admin.get('/me', (c) => {
    const user = c.get('session')?.user;
    if (user === undefined || user.role === 'user') return respondError(c, 'forbidden');
    return sendJson(c, AdminMe, { handle: user.handle, role: user.role }, CACHE_PRIVATE);
  });
  return admin;
}

/**
 * Routes that do not exist on the admin host (A§14: sign-up and uploads, a 404 there; Caddy refuses
 * them first). Explicit here so that P3b's upload routes are born refused on the admin host.
 */
export function publicOnly(site: SiteDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (isAdminHost(c.req.header('host'), site.adminHost)) return respondError(c, 'not_found');
    await next();
  };
}
