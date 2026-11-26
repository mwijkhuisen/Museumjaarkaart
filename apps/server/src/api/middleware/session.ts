import type { Context, MiddlewareHandler } from 'hono';
import { loadSession, readSessionCookie, type Session, type SessionHost } from '../../auth/session.ts';
import type { Db } from '../../db/kysely.ts';
import { ApiError } from '../errors.ts';
import { isAdminHost } from './access-jwt.ts';
import type { SiteDeps } from './csrf.ts';
import type { ApiEnv } from './request.ts';

// Reads the session cookie on the paths that may use a session (A§14: `/api/v1/auth/*`,
// `/api/v1/me*`, `/api/admin/*`); the catalogue never reads it. On the admin host the Access JWT
// has already been checked (accessJwt runs first), and a session counts only while its user's email
// equals the JWT's: otherwise it is no session here, and `adminMismatch` lets the admin gate answer
// 403 instead of 401 (A§9, D22). A sign-in then still works and replaces the stale row.

export const hostClass = (c: Context<ApiEnv>, site: SiteDeps): SessionHost =>
  isAdminHost(c.req.header('host'), site.adminHost) ? 'admin' : 'public';

/** The JWT's email in our normalised form (the contracts' Email lower-cases and trims). */
export const accessEmail = (c: Context<ApiEnv>): string | undefined => c.get('access')?.email.trim().toLowerCase();

export function sessionMiddleware(db: Db, site: SiteDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c.req.header('cookie'));
    if (token !== null) {
      const host = hostClass(c, site);
      const session = await loadSession(db, token, host);
      if (session !== null) {
        if (host === 'admin' && accessEmail(c) !== session.user.email) c.set('adminMismatch', true);
        else c.set('session', session);
      }
    }
    await next();
  };
}

/** The member's session on this host, or 401 `unauthorized`. */
export function requireMember(c: Context<ApiEnv>): Session {
  const session = c.get('session');
  if (session === undefined) throw new ApiError('unauthorized');
  return session;
}
