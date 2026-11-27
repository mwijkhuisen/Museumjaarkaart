import {
  EmptyQuery,
  Me,
  PasskeyReauthOptions,
  PasskeyReauthRequest,
  PasskeySignInOptions,
  PasskeySignInRequest,
} from '@mjk/contracts';
import type { Context } from 'hono';
import { BUCKETS, enforce, hitIp, ipKeys, refund } from '../../auth/limiter.ts';
import { readSessionCookie } from '../../auth/session.ts';
import {
  reauthOptions,
  type SignInResult,
  signInOptions,
  verifySignIn,
  type WebAuthnDeps,
} from '../../auth/webauthn.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { accessEmail, hostClass, requireMember } from '../middleware/session.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// Passkey sign-in (P2b; A§9, A§14). Both answers are private, no-store.
//   - options writes nothing: the challenge is stateless and signed for this host (auth/webauthn.ts),
//     so it needs no limit of its own (owner, Q4);
//   - verify reserves one slot of `passkey_fail_prefix` (30 an hour per IP prefix, its /48 at 4×)
//     before any work and gives it back once the signature verified; no client address → 429;
//   - a verified sign-in also counts in `passkey_user_hour` (30 an hour per member, auth/webauthn.ts);
//     past it the answer is 429 and no session starts (P2b review L1);
//   - on the admin host the Access JWT has passed already (accessJwt runs first), and only the
//     JWT's own account can sign in.
// Nothing here logs a credential id, a key, a challenge, a token or an email.

/** Reserves one failure slot per IP prefix key; returns the refund for a verified signature. */
async function reservePasskeyCheck(c: Context<ApiEnv>, deps: ApiDeps): Promise<() => Promise<void>> {
  const client = c.var.client;
  const bucket = BUCKETS.passkeyFailPrefix;
  const ip = await hitIp(deps.db, bucket, client);
  enforce(deps.logger, bucket, ip);
  const windowStart = (ip as NonNullable<typeof ip>).windowStart;
  return async () => {
    for (const k of ipKeys(client) ?? []) await refund(deps.db, bucket, k.key, windowStart);
  };
}

export function mountAuthPasskey(v1: ApiApp, deps: ApiDeps): void {
  const { keys, site } = deps;
  if (keys === undefined || site === undefined) throw new Error('passkey routes need keys and site');
  const wa: WebAuthnDeps = { db: deps.db, keys, site, logger: deps.logger };

  v1.post('/auth/passkey/options', (c) => {
    parseQuery(c, EmptyQuery);
    return sendJson(c, PasskeySignInOptions, signInOptions(wa, hostClass(c, site)), CACHE_PRIVATE);
  });

  /** The answer of a verify: the refusals' status codes, or 200 Me with the new session's cookie. */
  const answer = async (c: Context<ApiEnv>, result: SignInResult, refundVerified: () => Promise<void>) => {
    if (!result.ok) {
      // A banned member's signature verified, and so did one past passkey_user_hour: neither is a
      // failed guess (A§9, as for a password).
      if (result.code !== 'unauthorized') await refundVerified();
      if (result.code === 'rate_limited') throw new ApiError('rate_limited', undefined, result.retryAfterS);
      throw new ApiError(result.code);
    }
    await refundVerified();
    c.header('Set-Cookie', result.cookie);
    return sendJson(c, Me, { user: result.me }, CACHE_PRIVATE);
  };

  v1.post('/auth/passkey/verify', async (c) => {
    const { credential } = await readJson(c, PasskeySignInRequest);
    const host = hostClass(c, site);
    const refundVerified = await reservePasskeyCheck(c, deps);
    const result = await verifySignIn(wa, {
      host,
      credential,
      accessEmail: host === 'admin' ? accessEmail(c) : undefined,
      sentToken: readSessionCookie(c.req.header('cookie')),
    });
    return answer(c, result, refundVerified);
  });

  // Re-authentication with a passkey (owner, 2026-11-27): the signed-in member confirms it is them with
  // one of their own passkeys, for the 10-minute window of A§9. It never switches accounts: the options
  // list only this member's passkeys, the challenge is bound to this session, verify refuses another
  // member's credential, and the new session (a new token, the current row deleted, as after a code)
  // is this member's.
  v1.post('/auth/passkey/reauth/options', async (c) => {
    const session = requireMember(c);
    parseQuery(c, EmptyQuery);
    const result = await reauthOptions(wa, hostClass(c, site), session);
    if (!result.ok) throw new ApiError(result.code);
    return sendJson(c, PasskeyReauthOptions, result.options, CACHE_PRIVATE);
  });

  v1.post('/auth/passkey/reauth/verify', async (c) => {
    const session = requireMember(c);
    const { credential } = await readJson(c, PasskeyReauthRequest);
    const host = hostClass(c, site);
    const refundVerified = await reservePasskeyCheck(c, deps);
    const result = await verifySignIn(wa, {
      host,
      credential,
      accessEmail: host === 'admin' ? accessEmail(c) : undefined,
      sentToken: readSessionCookie(c.req.header('cookie')),
      reauth: session,
    });
    return answer(c, result, refundVerified);
  });
}
