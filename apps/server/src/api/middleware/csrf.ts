import type { Context, MiddlewareHandler } from 'hono';
import { respondError } from '../errors.ts';
import { isAdminHost } from './access-jwt.ts';
import type { ApiEnv } from './request.ts';

// CSRF and JSON-only mutations (A§9, A§14). hono's csrf() checks form content types only, so it is
// not used. Both run on every unsafe method, whatever the path, before any route: a future route is
// covered without opting in. The order in buildApp is body cap → csrf (403) → jsonOnly (415).
//
//   - An unsafe method needs `Sec-Fetch-Site: same-origin`, or, when the browser sent no
//     Sec-Fetch-Site, an `Origin` equal to this host's own origin. `same-site` is refused: the admin
//     host and the public host are same-site, and neither may post to the other.
//   - The origin comes from the host class and MJK_DOMAIN, never from the request's Host header.
//   - Without a site (the ssr's in-process app, which only reads), every unsafe method is refused.

const SAFE: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type SiteDeps = { domain: string; adminHost: string };

export const isUnsafe = (method: string): boolean => !SAFE.has(method.toUpperCase());

export function csrf(site: SiteDeps | undefined): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!isUnsafe(c.req.method)) return next();
    if (site === undefined) return respondError(c, 'forbidden');
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite !== undefined) {
      if (fetchSite.trim().toLowerCase() !== 'same-origin') return respondError(c, 'forbidden');
      return next();
    }
    const own = isAdminHost(c.req.header('host'), site.adminHost) ? site.adminHost : site.domain;
    if (c.req.header('origin') !== `https://${own}`) return respondError(c, 'forbidden');
    return next();
  };
}

/** `application/json`, with or without parameters such as `; charset=utf-8`, in any case. */
const JSON_TYPE = /^application\/json[\t ]*(;.*)?$/i;

export const isJsonType = (contentType: string): boolean => JSON_TYPE.test(contentType.trim());

/** `application/octet-stream` exactly, in any case; no parameters. */
const OCTET_TYPE = /^application\/octet-stream$/i;

/**
 * Mutations take only `application/json` (else 415): a typed body must be JSON, and a body without
 * a type is refused too. A body-less request (no length, or a length of 0, and no type) passes, so
 * sign-out needs neither. Runs after the body cap, so a Content-Length here is a plain decimal.
 * The requests `octet(c)` names (the upload chunks, P3b) take `application/octet-stream` and nothing else.
 */
export function jsonOnly(octet: (c: Context<ApiEnv>) => boolean = () => false): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!isUnsafe(c.req.method)) return next();
    const type = c.req.header('content-type');
    if (octet(c)) {
      if (type === undefined || !OCTET_TYPE.test(type.trim())) return respondError(c, 'unsupported_type');
      return next();
    }
    if (type !== undefined) {
      if (!isJsonType(type)) return respondError(c, 'unsupported_type');
      return next();
    }
    const length = c.req.header('content-length');
    if (length !== undefined && Number(length.trim()) > 0) return respondError(c, 'unsupported_type');
    return next();
  };
}
