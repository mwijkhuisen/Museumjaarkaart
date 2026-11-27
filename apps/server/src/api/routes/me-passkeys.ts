import {
  EmptyQuery,
  PasskeyItem,
  PasskeyList,
  PasskeyRegisterRequest,
  PasskeyRegistrationOptions,
  PasskeyRenameRequest,
} from '@mjk/contracts';
import { z } from 'zod';
import { BUCKETS, enforce, hit, passkeyUserKey, refund } from '../../auth/limiter.ts';
import { endUserSessions, requireReauth, requireReauthWithin } from '../../auth/session.ts';
import {
  ADD_REAUTH_S,
  registrationOptions,
  toPasskeyItem,
  verifyRegistration,
  type WebAuthnDeps,
} from '../../auth/webauthn.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { hostClass, requireMember } from '../middleware/session.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's passkeys (P2b WP3; A§9, A§14): GET /me/passkeys, POST /me/passkeys/options,
// POST /me/passkeys, PATCH and DELETE /me/passkeys/:ref. The WebAuthn work is in auth/webauthn.ts.
//   - every route needs a member's session and answers private, no-store; every query is keyed on
//     the session's user, so another member's ref is a 404, never a 403 ("self");
//   - adding needs a sign-in within 5 minutes at the options and within 10 at the end (Q1a); removing
//     needs 10, and ends every other session of the member (a lost device's sessions go with it);
//   - a member has 10 failed adds an hour (`passkey_register_user`, keyed by an HMAC of the user id),
//     then 429; a stored passkey gives its slot back;
//   - the list and the answers never carry a credential id, a public key, the transports or the counter.
// Nothing here logs: the core logs its fixed codes, and a ref, a name or a credential id never reaches a line.

export function mountMePasskeys(v1: ApiApp, deps: ApiDeps): void {
  const { db, keys, site } = deps;
  if (keys === undefined || site === undefined) throw new Error('me_passkeys_need_keys_and_site');
  const wa: WebAuthnDeps = { db, keys, site, logger: deps.logger };

  v1.get('/me/passkeys', async (c) => {
    const session = requireMember(c);
    const rows = await db
      .selectFrom('passkey')
      .select(['ref', 'name', 'created_at', 'last_used_at', 'backed_up'])
      .where('user_id', '=', session.user.id)
      .orderBy('created_at', 'desc')
      .orderBy('ref', 'desc')
      .execute();
    return sendJson(c, PasskeyList, { items: rows.map(toPasskeyItem) }, CACHE_PRIVATE);
  });

  v1.post('/me/passkeys/options', async (c) => {
    const session = requireMember(c);
    parseQuery(c, EmptyQuery);
    await requireReauthWithin(db, session, ADD_REAUTH_S);
    const result = await registrationOptions(wa, hostClass(c, site), session);
    if (!result.ok) {
      throw result.code === 'rate_limited'
        ? new ApiError('rate_limited', undefined, result.retryAfterS)
        : new ApiError(result.code);
    }
    return sendJson(c, PasskeyRegistrationOptions, result.options, CACHE_PRIVATE);
  });

  v1.post('/me/passkeys', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    const body = await readJson(c, PasskeyRegisterRequest);
    // P2b review L2: one slot of passkey_register_user reserved before the verify, given back on success.
    const bucket = BUCKETS.passkeyRegisterUser;
    const key = passkeyUserKey(keys, session.user.id);
    const slot = await hit(db, bucket, key);
    enforce(deps.logger, bucket, slot);
    const result = await verifyRegistration(wa, {
      host: hostClass(c, site),
      session,
      credential: body.credential,
      name: body.name,
    });
    // A stored passkey, and one refused by the day's add limit, are no failed registration.
    if (result.ok || result.code === 'rate_limited') await refund(db, bucket, key, slot.windowStart);
    if (!result.ok) {
      if (result.code === 'invalid') throw new ApiError('invalid', ['response']);
      if (result.code === 'rate_limited') throw new ApiError('rate_limited', undefined, result.retryAfterS);
      throw new ApiError(result.code);
    }
    return sendJson(c, PasskeyItem, result.item, CACHE_PRIVATE, 201);
  });

  v1.patch('/me/passkeys/:ref', async (c) => {
    const session = requireMember(c);
    const ref = parseParam('ref', c.req.param('ref'), z.uuid());
    const body = await readJson(c, PasskeyRenameRequest);
    const row = await db
      .updateTable('passkey')
      .set({ name: body.name })
      .where('ref', '=', ref)
      .where('user_id', '=', session.user.id)
      .returning(['ref', 'name', 'created_at', 'last_used_at', 'backed_up'])
      .executeTakeFirst();
    if (row === undefined) throw new ApiError('not_found');
    return sendJson(c, PasskeyItem, toPasskeyItem(row), CACHE_PRIVATE);
  });

  v1.delete('/me/passkeys/:ref', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    const ref = parseParam('ref', c.req.param('ref'), z.uuid());
    await db.transaction().execute(async (trx) => {
      const gone = await trx
        .deleteFrom('passkey')
        .where('ref', '=', ref)
        .where('user_id', '=', session.user.id)
        .returning('ref')
        .executeTakeFirst();
      if (gone === undefined) throw new ApiError('not_found');
      await endUserSessions(trx, session.user.id, session.id);
    });
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });
}
