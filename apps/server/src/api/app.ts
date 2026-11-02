import { EmptyQuery, Healthz } from '@mjk/contracts';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { CACHE_NONE } from './cache.ts';
import { ApiError, ContractMismatch, respondError } from './errors.ts';
import { type ApiEnv, requestLog } from './middleware/request.ts';
import { parseQuery } from './query.ts';
import { sendJson } from './respond.ts';
import { mountMkList } from './routes/mk-list.ts';
import { mountMuseumDetail } from './routes/museum-detail.ts';
import { mountMuseumsNear } from './routes/museums-near.ts';
import { mountProvinces } from './routes/provinces.ts';

// The `api` role's Hono app (A§5, A§14). Middleware order (phase plan §2): request id and log →
// 64 KB body cap → /api/admin/* is a 404 (P1e adds the Host and Access checks) → each route parses
// its query strictly → the route → the fixed error handler.

export type ApiDeps = {
  /** The pool as mjk_api; public queries read only the pub_* views. */
  db: Db;
  logger: Logger;
  /** `select 1` within a short timeout: false when the database does not answer. */
  ping(): Promise<boolean>;
};

export type ApiApp = Hono<ApiEnv>;
/** Registers routes on the `/api/v1` sub-app. */
export type Mount = (v1: ApiApp, deps: ApiDeps) => void;

export const BODY_LIMIT_BYTES = 64 * 1024;

/** SQLSTATEs and socket errors that mean the database is unavailable rather than a bug. */
function unavailable(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
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
  if (err instanceof ApiError) return respondError(c, err.code, err.fields);
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
  app.use('*', bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => respondError(c, 'too_large') }));
  // Invariant 3: no admin route on this host. P1e adds the admin host's Host and Access checks.
  app.all('/api/admin/*', (c) => respondError(c, 'not_found'));

  const v1 = new Hono<ApiEnv>();
  // A§14: select 1 → 200 {"ok":true}, else 503 {"ok":false}; no-store.
  v1.get('/healthz', async (c) => {
    parseQuery(c, EmptyQuery);
    const ok = await deps.ping();
    return sendJson(c, Healthz, { ok }, CACHE_NONE, ok ? 200 : 503);
  });
  mount(v1, deps);
  app.route('/api/v1', v1);

  app.notFound((c) => respondError(c, 'not_found'));
  app.onError((err, c) => onError(err, c, deps.logger));
  return app;
}

/**
 * Every catalogue route (P1b). Only the lead edits this list, so the route packages stay disjoint.
 * The first registered route answers, so the fixed /museums/… paths come before /museums/:slug.
 */
export function createApp(deps: ApiDeps): ApiApp {
  return buildApp(deps, (v1, d) => {
    mountProvinces(v1, d);
    mountMkList(v1, d);
    mountMuseumsNear(v1, d);
    mountMuseumDetail(v1, d);
  });
}
