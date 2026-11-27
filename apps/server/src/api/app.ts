import { CHUNK_BYTES, EmptyQuery, Healthz } from '@mjk/contracts';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { AppKeys } from '../auth/keys.ts';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { adminRoutes, publicOnly } from './admin.ts';
import { CACHE_NONE } from './cache.ts';
import { ApiError, ContractMismatch, respondError } from './errors.ts';
import { type AccessDeps, accessJwt } from './middleware/access-jwt.ts';
import { bodyCap } from './middleware/body-cap.ts';
import { type ClientAddressDeps, clientAddress } from './middleware/client-address.ts';
import { csrf, jsonOnly, type SiteDeps } from './middleware/csrf.ts';
import { type ApiEnv, requestLog } from './middleware/request.ts';
import { sessionMiddleware } from './middleware/session.ts';
import { parseQuery } from './query.ts';
import { sendJson } from './respond.ts';
import { mountMkList } from './routes/mk-list.ts';
import { mountMuseumDetail } from './routes/museum-detail.ts';
import { mountMuseumsList } from './routes/museums-list.ts';
import { mountMuseumsNear } from './routes/museums-near.ts';
import { mountMuseumsPoints } from './routes/museums-points.ts';
import { mountProvinces } from './routes/provinces.ts';
import { mountReviewsPublic } from './routes/reviews-public.ts';
import { mountUsers } from './routes/users.ts';

// The `api` role's Hono app (A§5, A§14). Middleware order (phase plan §2, P1e §2, P2a design 6):
// request id and log → the client address (A§9) → the Access JWT on the admin host (ADR-0004) →
// /api/admin/* is a 404 whatever the method and body unless the admin host's JWT passed → the
// header-only body cap (64 KiB; 2 MiB for an import, 8 MiB for an upload chunk, `bodyLimit`) → CSRF on every unsafe
// method (403) → JSON-only mutations (415; an upload chunk takes only application/octet-stream) → the session cookie,
// on the auth, me, admin, upload and media paths and the review writes only → each route parses its
// query and body strictly → the route → the fixed error handler.

export type ApiDeps = {
  /** The pool as mjk_api; public queries read only the pub_* views. */
  db: Db;
  logger: Logger;
  /** `select 1` within a short timeout: false when the database does not answer. */
  ping(): Promise<boolean>;
  /** The client-address rule; set only by runApi (the ssr's in-process app has no socket). */
  clientAddress?: ClientAddressDeps;
  /** The admin host's Access JWT check; set only by runApi, so the in-process app never serves it. */
  access?: AccessDeps;
  /** `<domain>` and `admin.<domain>`: the origins CSRF accepts. Without it every unsafe method is a 403. */
  site?: SiteDeps;
  /** The `app_keys` secret (P2a); set only by runApi, which also mounts the account routes with it. */
  keys?: AppKeys;
  /** The export bundles (A§17.1: `/srv/mjk/exports`, read-only for the api); set only by runApi (P2c). */
  exportsDir?: string;
  /** The upload quarantine (A§17.1: `/srv/mjk/quarantine`, shared with the worker); tests pass a temp directory (P3b). */
  quarantineDir?: string;
  /** The disk guard's directory (`/srv/mjk/state/guard`, read-only; owner Q6); tests pass a temp directory (P3b). */
  guardDir?: string;
};

export type ApiApp = Hono<ApiEnv>;
/** Registers routes on the `/api/v1` sub-app. */
export type Mount = (v1: ApiApp, deps: ApiDeps) => void;

export const BODY_LIMIT_BYTES = 64 * 1024;
/** An import's file and its confirm (P2c design 4; Caddy's `@import` has the same method and paths). */
export const IMPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const IMPORT_PATH = /^\/api\/v1\/me\/imports(?:\/[^/]+\/confirm)?$/;
/** An upload chunk (P3b; Caddy's `@chunk` has the same method and path). Shape only: the route checks the rest. */
const CHUNK_PATH = /^\/api\/v1\/uploads\/[0-9a-f-]{36}\/chunks\/[0-9]{1,2}$/;

/** `PUT /uploads/:id/chunks/:n`: the one route that takes `application/octet-stream`, up to 8 MiB. */
export const isChunk = (c: Context<ApiEnv>): boolean => c.req.method === 'PUT' && CHUNK_PATH.test(c.req.path);

/** The body cap of one request: 8 MiB for an upload chunk, 2 MiB for `POST /me/imports` and its confirm, else 64 KiB. */
export const bodyLimit = (c: Context<ApiEnv>): number => {
  if (isChunk(c)) return CHUNK_BYTES;
  return c.req.method === 'POST' && IMPORT_PATH.test(c.req.path) ? IMPORT_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES;
};

/**
 * The fixed messages of the node-postgres errors that carry no `code`: a saturated pool
 * (pg-pool 3.14) and a dropped or timed-out connection (pg 8.23). Compared exactly; the message
 * only chooses the status and is never logged or returned.
 */
const POOL_MESSAGES: ReadonlySet<string> = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Connection terminated',
]);

/** SQLSTATEs, socket errors and pool errors that mean the database is unavailable rather than a bug. */
export function unavailable(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return err instanceof Error && POOL_MESSAGES.has(err.message);
  return (
    code.startsWith('08') || // connection exception
    ['57014', '57P01', '57P02', '57P03', '53300'].includes(code) || // timeout, shutdown, too many connections
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
  );
}

/** A pg error's five-character SQLSTATE, or null: the only detail of an error that reaches a log. */
const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

function onError(err: Error, c: Context, logger: Logger): Response {
  if (err instanceof ApiError) return respondError(c, err.code, err.fields, err.retryAfter);
  if (err instanceof ContractMismatch) {
    logger.error({}, 'contract_mismatch');
    return respondError(c, 'internal');
  }
  if (unavailable(err)) {
    logger.warn({ sqlstate: sqlstate(err) }, 'db_unavailable');
    return respondError(c, 'unavailable');
  }
  // Never the message or the stack: either can quote data.
  logger.error({ sqlstate: sqlstate(err) }, 'internal_error');
  return respondError(c, 'internal');
}

/** The app with the shared middleware, healthz and the routes `mount` adds (tests mount their own). */
export function buildApp(deps: ApiDeps, mount: Mount): ApiApp {
  const app = new Hono<ApiEnv>();
  app.use('*', requestLog(deps.logger));
  if (deps.clientAddress !== undefined) app.use('*', clientAddress(deps.clientAddress));
  // First on the admin host, before any route, the auth routes included (A§9).
  if (deps.access !== undefined) app.use('*', accessJwt(deps.access, deps.logger));
  // Invariant 3: no admin route on any host but the admin host, and there only behind a valid
  // Access JWT (`access` is set by nothing else). Registered before the body cap, so an admin path
  // is a 404 whatever the method and body. Behind it, adminRoutes() also needs an admin-host
  // session of the JWT's email and the role (D22; api/admin.ts).
  app.all('/api/admin/*', async (c, next) => {
    if (c.var.access === undefined) return respondError(c, 'not_found');
    await next();
  });
  app.use('*', bodyCap(bodyLimit));
  app.use('*', csrf(deps.site));
  app.use('*', jsonOnly(isChunk));
  // The session cookie is read only where a session can matter (A§14: public routes never read it).
  if (deps.site !== undefined && deps.keys !== undefined) {
    const withSession = sessionMiddleware(deps.db, deps.site);
    for (const path of [
      '/api/v1/auth/*',
      '/api/v1/me',
      '/api/v1/me/*',
      '/api/admin/*',
      // P3b: the uploads and the member's own photos; none of these is public.
      '/api/v1/uploads',
      '/api/v1/uploads/*',
      '/api/v1/media/*',
    ])
      app.use(path, withSession);
    // The review writes need a member; a public GET of a review never reads the cookie (P3a).
    const onWrite: MiddlewareHandler<ApiEnv> = (c, next) =>
      c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : withSession(c, next);
    for (const path of ['/api/v1/reviews', '/api/v1/reviews/*']) app.use(path, onWrite);
    // Sign-up, uploads and the member's photo routes do not exist on the admin host (A§14).
    const notOnAdmin = publicOnly(deps.site);
    for (const path of ['/api/v1/auth/signup', '/api/v1/uploads', '/api/v1/uploads/*', '/api/v1/media/*'])
      app.use(path, notOnAdmin);
  }

  const v1 = new Hono<ApiEnv>();
  // A§14: select 1 → 200 {"ok":true}, else 503 {"ok":false}; no-store.
  v1.get('/healthz', async (c) => {
    parseQuery(c, EmptyQuery);
    const ok = await deps.ping();
    return sendJson(c, Healthz, { ok }, CACHE_NONE, ok ? 200 : 503);
  });
  mount(v1, deps);
  app.route('/api/v1', v1);
  if (deps.site !== undefined && deps.keys !== undefined) app.route('/api/admin', adminRoutes());

  app.notFound((c) => {
    c.set('unmatched', true);
    return respondError(c, 'not_found');
  });
  app.onError((err, c) => onError(err, c, deps.logger));
  return app;
}

/**
 * Every catalogue route (P1b). Only the lead edits this list, so the route packages stay disjoint.
 * The first registered route answers, so the fixed /museums/… paths come before /museums/:slug.
 * The `ssr` role mounts the same list on its own in-process app (P1c).
 */
export const mountCatalogue: Mount = (v1, d) => {
  mountProvinces(v1, d);
  mountMkList(v1, d);
  mountMuseumsList(v1, d);
  mountMuseumsNear(v1, d);
  mountMuseumsPoints(v1, d);
  mountMuseumDetail(v1, d);
  // P2c: the public profiles; outside the session paths, readable as mjk_ssr.
  mountUsers(v1, d);
  // P3a: one review and a museum's reviews; the member's own writes are in mountAccounts.
  mountReviewsPublic(v1, d);
};

// The api role's own app (the catalogue plus the account routes, mountAccounts and createApp) lives
// in create-app.ts, which the ssr role never loads (P2b code review).
