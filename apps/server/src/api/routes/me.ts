import { Accepted, EmailChangeRequest, EmailVerifyRequest, Me, MePatchRequest, SessionList } from '@mjk/contracts';
import type { Context } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import { checkCode, consumeCode, issueCode } from '../../auth/codes.ts';
import { BUCKETS, type Bucket, emailKey, enforce, hit, hitIp, ipKeys, peek, refund } from '../../auth/limiter.ts';
import { settingsOf, toMeUser } from '../../auth/me.ts';
import { endUserSessions, requireReauth, type SessionHost, type SessionMethod } from '../../auth/session.ts';
import { enqueueMailNotice } from '../../mail/payloads.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ClientAddress } from '../middleware/client-address.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's own account routes (A§9, A§10, A§14). Every answer is private, no-store. "self" only:
// every query is keyed on the session's user, so another member's row is a 404, never a 403.

/** Stands in for the address of a member without a pending code, so the check runs the same statements and fails. */
const NO_EMAIL = 'none@invalid';
const UNIQUE_VIOLATION = '23505';

/** The client address, or the limiter's 429: a write that logs the address, or counts against it, never runs without one. */
function clientOr429(c: Context<ApiEnv>, deps: ApiDeps, bucket: Bucket): ClientAddress {
  const client = c.var.client;
  if (client === undefined) {
    enforce(deps.logger, bucket, null);
    throw new ApiError('rate_limited');
  }
  return client;
}

/** A pg error's SQLSTATE, never its message. */
const sqlstate = (err: unknown): string | undefined => (err as { code?: unknown }).code as string | undefined;

export function mountMe(v1: ApiApp, deps: ApiDeps): void {
  const { db, keys, site } = deps;
  if (keys === undefined || site === undefined) throw new Error('me_routes_need_keys_and_site');

  v1.get('/me', (c) => {
    const session = c.var.session;
    return sendJson(c, Me, { user: session === undefined ? null : toMeUser(session.user) }, CACHE_PRIVATE);
  });

  v1.patch('/me', async (c) => {
    const session = requireMember(c);
    const body = await readJson(c, MePatchRequest);
    const user = session.user;
    const displayName = body.display_name ?? user.display_name;
    const settings = { ...settingsOf(user.settings), ...body.settings };
    const nameChanged = displayName !== user.display_name;
    // Q7: a display-name change creates content, so its address is logged; no address, no write.
    const client = nameChanged ? clientOr429(c, deps, BUCKETS.codePrefix) : undefined;
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('app_user')
        .set({ display_name: displayName, settings: JSON.stringify(settings) })
        .where('id', '=', user.id)
        .execute();
      if (client !== undefined) {
        await trx
          .insertInto('content_ip_log')
          .values({ user_id: user.id, target_kind: 'app_user', target_id: user.id, ip: client.address })
          .execute();
      }
    });
    return sendJson(c, Me, { user: toMeUser({ ...user, display_name: displayName, settings }) }, CACHE_PRIVATE);
  });

  v1.post('/me/email', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    const body = await readJson(c, EmailChangeRequest);
    if (body.email === session.user.email) throw new ApiError('invalid', ['email']);
    const client = clientOr429(c, deps, BUCKETS.codePrefix);
    enforce(deps.logger, BUCKETS.codePrefix, await hitIp(db, BUCKETS.codePrefix, client));
    const perPrefix = await hit(db, BUCKETS.codeEmailPrefix, emailKey(keys, `${body.email}\n${client.prefix}`));
    enforce(deps.logger, BUCKETS.codeEmailPrefix, perPrefix);
    enforce(deps.logger, BUCKETS.codeEmailDay, await hit(db, BUCKETS.codeEmailDay, emailKey(keys, body.email)));
    // The worker drops the mail when the address already has an account: the answer is the same either way.
    await db.transaction().execute((trx) =>
      issueCode(trx, keys, {
        email: body.email,
        purpose: 'email_change',
        locale: body.locale,
        pending: { user_id: session.user.id },
      }),
    );
    return sendJson(c, Accepted, { accepted: true }, CACHE_PRIVATE, 202);
  });

  v1.post('/me/email/verify', async (c) => {
    const session = requireMember(c);
    const body = await readJson(c, EmailVerifyRequest);
    const client = clientOr429(c, deps, BUCKETS.verifyFailPrefix);
    const userId = session.user.id;

    // The newest email-change code this member asked for, matched on a bound text parameter.
    const mine = await db
      .selectFrom('email_code')
      .select('email')
      .where('purpose', '=', 'email_change')
      .where(sql<string>`pending->>'user_id'`, '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const email = mine?.email ?? NO_EMAIL;

    // Reserve the failure rows first, so parallel guesses cannot outrun the limits; a success refunds them.
    // Above the site-wide threshold A§9 wants an ALTCHA; here the member simply retries later (400 `altcha`).
    if ((await peek(db, BUCKETS.verifyFailSite, 'site')) >= BUCKETS.verifyFailSite.limit) {
      throw new ApiError('bad_request', ['altcha']);
    }
    const ipHit = await hitIp(db, BUCKETS.verifyFailPrefix, client);
    enforce(deps.logger, BUCKETS.verifyFailPrefix, ipHit);
    const siteHit = await hit(db, BUCKETS.verifyFailSite, 'site');

    const checked = await checkCode(db, keys, { email, purpose: 'email_change', code: body.code });
    const pendingUser = checked.ok ? (checked.pending as { user_id?: unknown } | null)?.user_id : undefined;
    if (!checked.ok || pendingUser !== userId) throw new ApiError('unauthorized');

    await refund(db, BUCKETS.verifyFailSite, 'site', siteHit.windowStart);
    if (ipHit !== null) {
      for (const k of ipKeys(client) ?? []) await refund(db, BUCKETS.verifyFailPrefix, k.key, ipHit.windowStart);
    }

    try {
      await db.transaction().execute(async (trx) => {
        if (!(await consumeCode(trx, checked.id))) throw new ApiError('unauthorized');
        await trx
          .updateTable('app_user')
          .set({ email, email_verified_at: sql<Date>`now()` })
          .where('id', '=', userId)
          .execute();
        await endUserSessions(trx, userId, session.id);
        await enqueueMailNotice(trx, keys, {
          userId,
          to: session.user.email,
          locale: settingsOf(session.user.settings).locale,
        });
      });
    } catch (err) {
      if (sqlstate(err) === UNIQUE_VIOLATION) throw new ApiError('conflict');
      throw err;
    }
    return sendJson(c, Me, { user: toMeUser({ ...session.user, email }) }, CACHE_PRIVATE);
  });

  v1.get('/me/sessions', async (c) => {
    const session = requireMember(c);
    const rows = await db
      .selectFrom('session')
      .select(['id', 'ref', 'host', 'method', 'created_at', 'last_used_at'])
      .where('user_id', '=', session.user.id)
      .where('expires_at', '>', sql<Date>`now()`)
      .where('absolute_expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .orderBy('ref', 'desc')
      .execute();
    const items = rows.map((r) => ({
      ref: r.ref,
      host: r.host as SessionHost,
      method: r.method as SessionMethod,
      created_at: (r.created_at as Date).toISOString(),
      last_used_at: (r.last_used_at as Date).toISOString(),
      current: session.id.equals(r.id),
    }));
    return sendJson(c, SessionList, { items }, CACHE_PRIVATE);
  });

  v1.delete('/me/sessions/:ref', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    const ref = parseParam('ref', c.req.param('ref'), z.uuid());
    const gone = await db
      .deleteFrom('session')
      .where('ref', '=', ref)
      .where('user_id', '=', session.user.id)
      .returning('ref')
      .executeTakeFirst();
    if (gone === undefined) throw new ApiError('not_found');
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });
}
