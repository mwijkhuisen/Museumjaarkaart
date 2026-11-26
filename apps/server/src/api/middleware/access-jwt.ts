import type { MiddlewareHandler } from 'hono';
import { decode, verifyWithJwks } from 'hono/utils/jwt/jwt';
import {
  JwtPayloadRequiresAud,
  JwtTokenAudience,
  JwtTokenExpired,
  JwtTokenIssuer,
  JwtTokenSignatureMismatched,
} from 'hono/utils/jwt/types';
import { z } from 'zod';
import type { Logger } from '../../lib/log.ts';
import { respondError } from '../errors.ts';
import type { ApiEnv } from './request.ts';

// The Cloudflare Access JWT on the admin host (A§9 "Admin host", ADR-0004, invariant 3). It runs
// first on every request whose Host is `admin.<domain>`, the auth routes included; every other host
// passes untouched (and gets the /api/admin/* 404 after it). F1's own middleware on hono's
// `verifyWithJwks`, because `hono/jwk` accepts only `Bearer` and Cloudflare sends the bare JWT in
// `Cf-Access-Jwt-Assertion`:
//
//   - RS256 with a `kid`, nothing else (no `none`, no HS*, no other asymmetric algorithm);
//   - `iss` = `https://<team>.cloudflareaccess.com`, `aud` contains CF_ACCESS_AUD;
//   - `exp` required (hono's `verify` skips an absent one), checked by hono with no leeway;
//   - `nbf` with 60 s of skew (hono's own check has none, so it is off and done here); `iat` unchecked;
//   - an `email` claim, the identity P2a matches against the admin-host session's user.
//
// Every refusal is the same 401 `{"error":"unauthorized"}` (byte-identical body and headers, apart
// from the request id) and one log code, `access_refused`, with a fixed reason. The certs come from
// `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` through global `fetch` (msw intercepts
// it in tests; CI never calls Cloudflare): fresh for 5 min, used stale for up to 1 h while a refresh
// fails, then 503 `unavailable`. An unknown `kid` refetches at most once per CERTS_RETRY_MS.
//
// The role check (`moderator` or `admin`, an admin-host session, the JWT's email equal to the
// user's) needs users and arrives in P2a: it reads `c.var.access`, which is set only here.

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const CERTS_FRESH_MS = 5 * 60_000;
export const CERTS_STALE_MS = 60 * 60_000;
/** The shortest gap between two certs fetches: after a failure, and for an unknown `kid`. */
export const CERTS_RETRY_MS = 60_000;
export const CERTS_TIMEOUT_MS = 5_000;
export const CERTS_MAX_BYTES = 64 * 1024;
export const NBF_SKEW_S = 60;
/** Far above an Access JWT (about 1 kB); refused before any decoding. */
const MAX_TOKEN = 8 * 1024;
/** Three base64url segments. Anchored, and no class matches the dot, so it runs in linear time. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const issuerOf = (team: string) => `https://${team}.cloudflareaccess.com`;
export const certsUrlOf = (team: string) => `${issuerOf(team)}/cdn-cgi/access/certs`;

/** What a valid JWT proves: the email Access let through. */
export type AccessIdentity = { email: string };

export type RefusalReason =
  | 'missing'
  | 'malformed'
  | 'header'
  | 'kid'
  | 'signature'
  | 'iss'
  | 'aud'
  | 'exp'
  | 'nbf'
  | 'claims'
  | 'invalid';

/** An RSA public key as the cache keeps it: only the fields the check needs. */
export type RsaJwk = { kty: 'RSA'; kid: string; n: string; e: string; alg: 'RS256' };

export type JwksCache = {
  /** The key for `kid`, `unknown` when the (fresh or stale) set has none, `unavailable` without a usable set. */
  key(kid: string): Promise<RsaJwk | 'unknown' | 'unavailable'>;
};

export type JwksCacheOpts = {
  url: string;
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

const B64URL = /^[A-Za-z0-9_-]+$/;
const Jwk = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1).max(200),
  n: z.string().min(342).max(1366).regex(B64URL), // 2048 to 8192 bits
  e: z.string().min(1).max(16).regex(B64URL),
  alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(),
});
const Jwks = z.object({ keys: z.array(z.unknown()).max(50) });

/** The body's bytes, or null once it passes `max` (the stream is cancelled). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One certs fetch: the RS256 signing keys, or null on any failure (never throws, logs nothing). */
async function fetchKeys(opts: JwksCacheOpts): Promise<Map<string, RsaJwk> | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? CERTS_TIMEOUT_MS);
  try {
    // A redirect could leave Cloudflare: refused.
    const res = await doFetch(opts.url, { redirect: 'error', signal, headers: { accept: 'application/json' } });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res, CERTS_MAX_BYTES);
    if (bytes === null) return null;
    const parsed = Jwks.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!parsed.success) return null;
    const keys = new Map<string, RsaJwk>();
    for (const raw of parsed.data.keys) {
      // A key of another type or use is skipped, not an error: the set may grow.
      const k = Jwk.safeParse(raw);
      if (k.success && !keys.has(k.data.kid))
        keys.set(k.data.kid, { kty: 'RSA', kid: k.data.kid, n: k.data.n, e: k.data.e, alg: 'RS256' });
    }
    return keys.size > 0 ? keys : null;
  } catch {
    return null;
  }
}

/** The certs cache: fresh for CERTS_FRESH_MS, stale for up to CERTS_STALE_MS, one fetch at a time. */
export function createJwksCache(opts: JwksCacheOpts): JwksCache {
  const now = opts.now ?? Date.now;
  let keys: Map<string, RsaJwk> | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      attemptedAt = now();
      const got = await fetchKeys(opts);
      if (got === null) {
        opts.logger.warn({}, 'access_certs_fetch_failed');
        return;
      }
      keys = got;
      fetchedAt = now();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async key(kid) {
      if (inflight !== null) await inflight;
      const t = now();
      const fresh = keys !== null && t - fetchedAt < CERTS_FRESH_MS;
      const mayFetch = t - attemptedAt >= CERTS_RETRY_MS;
      if (mayFetch && (!fresh || !keys?.has(kid))) await refresh();
      if (keys === null || now() - fetchedAt >= CERTS_STALE_MS) return 'unavailable';
      return keys.get(kid) ?? 'unknown';
    },
  };
}

export type AccessDeps = {
  /** `admin.<domain>`, lowercase. */
  adminHost: string;
  /** `https://<team>.cloudflareaccess.com`. */
  issuer: string;
  /** CF_ACCESS_AUD. */
  audience: string;
  keys: JwksCache;
  /** Seconds since the epoch, for the `nbf` skew (hono's own `exp` check reads the clock itself). */
  nowS?: () => number;
};

/**
 * Whether a Host header names the admin host. Fail closed: every spelling that Caddy's host matcher
 * could route to the admin block counts, so the name part decides. Caddy's MatchHost takes
 * net.SplitHostPort's host (which drops one pair of brackets and the port), or, when that fails, the
 * whole value with one leading `[` and one trailing `]` trimmed. So: a value that starts with `[` keeps
 * what lies between it and the first `]` (or everything after it, with no `]`); any other value drops
 * everything from the first `:` (an empty, non-numeric or out-of-range port included), then one
 * trailing `]`. Then any trailing dots, then case. The result must equal the admin host exactly, so
 * nothing looser than "the name part is the admin host" ever counts. No Host is not the admin host
 * (the public host has no admin route).
 */
export function isAdminHost(host: string | undefined, adminHost: string): boolean {
  if (host === undefined) return false;
  let h = host;
  if (h.startsWith('[')) {
    h = h.slice(1);
    const close = h.indexOf(']');
    if (close !== -1) h = h.slice(0, close);
  } else {
    const colon = h.indexOf(':');
    if (colon !== -1) h = h.slice(0, colon);
    if (h.endsWith(']')) h = h.slice(0, -1);
  }
  // A scan from the end, never a `x+$` regex on request text (CLAUDE.md gotcha).
  let end = h.length;
  while (end > 0 && h.charCodeAt(end - 1) === 0x2e) end--;
  return h.slice(0, end).toLowerCase() === adminHost;
}

type Outcome = { ok: true; identity: AccessIdentity } | { ok: false; reason: RefusalReason } | { ok: 'unavailable' };

const refused = (reason: RefusalReason): Outcome => ({ ok: false, reason });

function reasonOf(err: unknown): RefusalReason {
  if (err instanceof JwtTokenSignatureMismatched) return 'signature';
  if (err instanceof JwtTokenIssuer) return 'iss';
  if (err instanceof JwtTokenAudience || err instanceof JwtPayloadRequiresAud) return 'aud';
  if (err instanceof JwtTokenExpired) return 'exp';
  return 'invalid';
}

/** The full check of one `Cf-Access-Jwt-Assertion` value. Never throws. */
export async function checkAccessJwt(token: string | undefined, deps: AccessDeps): Promise<Outcome> {
  if (token === undefined || token === '') return refused('missing');
  if (token.length > MAX_TOKEN || !JWT_SHAPE.test(token)) return refused('malformed');
  let header: unknown;
  try {
    header = decode(token).header;
  } catch {
    return refused('malformed');
  }
  const { alg, kid } = header as { alg?: unknown; kid?: unknown };
  if (alg !== 'RS256' || typeof kid !== 'string' || kid === '') return refused('header');
  const key = await deps.keys.key(kid);
  if (key === 'unavailable') return { ok: 'unavailable' };
  if (key === 'unknown') return refused('kid');
  let payload: Record<string, unknown>;
  try {
    payload = await verifyWithJwks(token, {
      keys: [key],
      allowedAlgorithms: ['RS256'],
      verification: { iss: deps.issuer, aud: deps.audience, exp: true, nbf: false, iat: false },
    });
  } catch (err) {
    return refused(reasonOf(err));
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return refused('exp');
  if (payload.nbf !== undefined) {
    const nowS = deps.nowS?.() ?? Math.floor(Date.now() / 1000);
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowS + NBF_SKEW_S)
      return refused('nbf');
  }
  const email = payload.email;
  if (typeof email !== 'string' || email === '' || email.length > 320) return refused('claims');
  return { ok: true, identity: { email } };
}

/** The admin-host gate. Sets `access` on the context only for a valid JWT on the admin host. */
export function accessJwt(deps: AccessDeps, logger: Logger): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!isAdminHost(c.req.header('host'), deps.adminHost)) return next();
    const outcome = await checkAccessJwt(c.req.header(ACCESS_HEADER), deps);
    if (outcome.ok === 'unavailable') {
      logger.error({}, 'access_certs_unavailable');
      return respondError(c, 'unavailable');
    }
    if (!outcome.ok) {
      logger.warn({ reason: outcome.reason }, 'access_refused');
      return respondError(c, 'unauthorized');
    }
    c.set('access', outcome.identity);
    await next();
  };
}
