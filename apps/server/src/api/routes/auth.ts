import {
  Accepted,
  AltchaChallenge,
  CodeRequest,
  CodeVerifyRequest,
  Me,
  RESERVED_HANDLES,
  SignupRequest,
  TERMS_VERSION,
} from '@mjk/contracts';
import type { Context } from 'hono';
import { z } from 'zod';
import { newChallenge, spendAltcha } from '../../auth/altcha.ts';
import { checkCode, consumeCode, issueCode } from '../../auth/codes.ts';
import { consumeInvite, findUsableInvite } from '../../auth/invite.ts';
import type { AppKeys } from '../../auth/keys.ts';
import { BUCKETS, emailKey, enforce, type Hit, hit, hitIp, ipKeys, peek, refund } from '../../auth/limiter.ts';
import { loadUser, toMeUser } from '../../auth/me.ts';
import { CLEAR_COOKIE, endSession, endUserSessions, readSessionCookie, startSession } from '../../auth/session.ts';
import type { Db } from '../../db/kysely.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { accessEmail, hostClass, requireMember } from '../middleware/session.ts';
import { sendJson } from '../respond.ts';

// The code-based auth routes (A§9, A§14, P2a designs 1–4). Every answer is private, no-store.
//   - Sign-up and code requests do the same work whatever the email (the worker decides whether the
//     mail goes out), so the 202 and its timing never tell whether an account exists.
//   - Verify reserves the failure buckets before comparing and refunds them on success; above the
//     site-wide failure threshold it also needs an ALTCHA solution (400 `fields: ["altcha"]`).
//   - On the admin host the Access JWT has passed already (accessJwt runs first); sign-up does not
//     exist there, and an email other than the JWT's gets the route's ordinary failure answer.
// Nothing here logs an email, a code, a token or a cookie.

type Host = 'public' | 'admin';

const SignupPending = z.strictObject({
  handle: z.string(),
  display_name: z.string(),
  invite_id: z.uuid(),
  terms_version: z.string(),
  locale: z.enum(['nl', 'en']),
});

const RESERVED = new Set(RESERVED_HANDLES);

const accepted = (c: Context<ApiEnv>) => sendJson(c, Accepted, { accepted: true }, CACHE_PRIVATE, 202);

const noContent = (c: Context<ApiEnv>, cookie?: string) => {
  c.header('Cache-Control', CACHE_PRIVATE);
  if (cookie !== undefined) c.header('Set-Cookie', cookie);
  return c.body(null, 204);
};

/** A pg unique violation (by SQLSTATE, never by message). */
const isUniqueViolation = (err: unknown) => (err as { code?: unknown }).code === '23505';

/** The code-request limits shared by sign-up and /auth/code (A§9 table). */
async function codeRequestLimits(c: Context<ApiEnv>, deps: ApiDeps & { keys: AppKeys }, email: string) {
  const client = c.var.client;
  const ip = await hitIp(deps.db, BUCKETS.codePrefix, client);
  enforce(deps.logger, BUCKETS.codePrefix, ip);
  const prefix = client?.prefix ?? '';
  const pair = await hit(deps.db, BUCKETS.codeEmailPrefix, emailKey(deps.keys, `${email}\n${prefix}`));
  enforce(deps.logger, BUCKETS.codeEmailPrefix, pair);
  const day = await hit(deps.db, BUCKETS.codeEmailDay, emailKey(deps.keys, email));
  enforce(deps.logger, BUCKETS.codeEmailDay, day);
}

/**
 * Reserves the failure buckets of one code check (A§9: 30 failures an hour per IP prefix; the
 * site-wide count). Above the site-wide threshold the request must also carry a valid ALTCHA
 * solution. Returns the refund to run when the code turns out right.
 */
export async function reserveCodeCheck(
  c: Context<ApiEnv>,
  deps: ApiDeps & { keys: AppKeys },
  host: Host,
  altcha: string | undefined,
): Promise<() => Promise<void>> {
  const client = c.var.client;
  if ((await peek(deps.db, BUCKETS.verifyFailSite, 'site')) >= BUCKETS.verifyFailSite.limit) {
    if (altcha === undefined || !(await spendAltcha(deps.db, deps.keys, host, altcha))) {
      throw new ApiError('bad_request', ['altcha']);
    }
  }
  const ip: Hit | null = await hitIp(deps.db, BUCKETS.verifyFailPrefix, client);
  enforce(deps.logger, BUCKETS.verifyFailPrefix, ip);
  const site = await hit(deps.db, BUCKETS.verifyFailSite, 'site');
  return async () => {
    for (const k of ipKeys(client) ?? []) {
      await refund(
        deps.db,
        { ...BUCKETS.verifyFailPrefix, limit: BUCKETS.verifyFailPrefix.limit * k.factor },
        k.key,
        (ip as Hit).windowStart,
      );
    }
    await refund(deps.db, BUCKETS.verifyFailSite, 'site', site.windowStart);
  };
}

/** Starts the session of a signed-in user and answers 200 with Me and the cookie. */
async function signedIn(c: Context<ApiEnv>, trx: Db, userId: string, host: Host) {
  const s = await startSession(trx, {
    userId,
    host,
    method: 'code',
    sentToken: readSessionCookie(c.req.header('cookie')),
  });
  const user = await loadUser(trx, userId);
  if (user === undefined) throw new Error('user_vanished');
  return { cookie: s.cookie, me: toMeUser(user) };
}

export function mountAuth(v1: ApiApp, deps: ApiDeps): void {
  const { keys, site } = deps;
  if (keys === undefined || site === undefined) throw new Error('auth routes need keys and site');
  const d = { ...deps, keys };

  v1.get('/auth/altcha', async (c) =>
    sendJson(c, AltchaChallenge, await newChallenge(keys, hostClass(c, site)), CACHE_PRIVATE),
  );

  v1.post('/auth/signup', async (c) => {
    // Sign-up does not exist on the admin host (A§14; Caddy refuses it there too).
    if (hostClass(c, site) === 'admin') throw new ApiError('not_found');
    const body = await readJson(c, SignupRequest);
    // The honeypot: a filled one gets the ordinary answer and nothing happens.
    if (body.website !== undefined && body.website !== '') return accepted(c);
    const invalid: string[] = [];
    if (body.age_confirmed !== true) invalid.push('age_confirmed');
    if (body.terms_version !== TERMS_VERSION) invalid.push('terms_version');
    if (RESERVED.has(body.handle)) invalid.push('handle');
    if (invalid.length > 0) throw new ApiError('invalid', invalid);
    if (!(await spendAltcha(deps.db, keys, 'public', body.altcha))) throw new ApiError('bad_request', ['altcha']);
    await codeRequestLimits(c, d, body.email);
    const inviteId = await findUsableInvite(deps.db, keys, body.invite);
    if (inviteId === undefined) throw new ApiError('forbidden');
    const taken = await deps.db
      .selectFrom('app_user')
      .select('id')
      .where('handle', '=', body.handle)
      .executeTakeFirst();
    if (taken !== undefined) throw new ApiError('conflict', ['handle']);
    // A§17.7: anonymous-triggered mails a day, site-wide. Counted per accepted request, whatever the
    // email, so the budget never tells whether an account exists (the worker may still drop the mail).
    const budget = await hit(deps.db, BUCKETS.signupSiteDay, 'site');
    enforce(deps.logger, BUCKETS.signupSiteDay, budget);
    await deps.db.transaction().execute((trx) =>
      issueCode(trx, keys, {
        email: body.email,
        purpose: 'signup',
        locale: body.locale,
        pending: {
          handle: body.handle,
          display_name: body.display_name,
          invite_id: inviteId,
          terms_version: body.terms_version,
          locale: body.locale,
        },
      }),
    );
    return accepted(c);
  });

  v1.post('/auth/code', async (c) => {
    const body = await readJson(c, CodeRequest);
    const host = hostClass(c, site);
    if (!(await spendAltcha(deps.db, keys, host, body.altcha))) throw new ApiError('bad_request', ['altcha']);
    await codeRequestLimits(c, d, body.email);
    // An admin-host session only for the Access JWT's email (A§9): any other gets the same 202, and nothing.
    if (host === 'admin' && accessEmail(c) !== body.email) return accepted(c);
    await deps.db
      .transaction()
      .execute((trx) => issueCode(trx, keys, { email: body.email, purpose: 'signin', locale: body.locale }));
    return accepted(c);
  });

  v1.post('/auth/code/verify', async (c) => {
    const body = await readJson(c, CodeVerifyRequest);
    const host = hostClass(c, site);
    const refundOnSuccess = await reserveCodeCheck(c, d, host, body.altcha);
    // The admin host signs in only the JWT's own email, and never completes a sign-up.
    const allowed = host === 'public' || (body.purpose === 'signin' && accessEmail(c) === body.email);
    const check = await checkCode(deps.db, keys, { email: body.email, purpose: body.purpose, code: body.code });
    if (!check.ok || !allowed) throw new ApiError('unauthorized');
    await refundOnSuccess();

    const result = await deps.db.transaction().execute(async (trx) => {
      if (!(await consumeCode(trx, check.id))) throw new ApiError('unauthorized');
      if (body.purpose === 'signin') {
        const user = await trx
          .selectFrom('app_user')
          .select(['id', 'status'])
          .where('email', '=', body.email)
          .executeTakeFirst();
        if (user === undefined || user.status === 'deleted') throw new ApiError('unauthorized');
        if (user.status === 'banned') throw new ApiError('banned');
        return signedIn(c, trx, user.id, host);
      }
      // Sign-up: the invite is consumed in the transaction that creates the account (A§9).
      const pending = SignupPending.safeParse(check.pending);
      if (!pending.success) throw new ApiError('unauthorized');
      const p = pending.data;
      if (!(await consumeInvite(trx, p.invite_id))) throw new ApiError('forbidden');
      let userId: string;
      try {
        const row = await trx
          .insertInto('app_user')
          .values({
            email: body.email,
            email_verified_at: new Date(),
            handle: p.handle,
            display_name: p.display_name,
            age_confirmed_at: new Date(),
            terms_version: p.terms_version,
            terms_accepted_at: new Date(),
            settings: JSON.stringify({ locale: p.locale }),
            invite_id: p.invite_id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        userId = row.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError('conflict');
        throw err;
      }
      // Q7: the full IP of a content-creating request, 30 days (A§9, A§13.2).
      const ip = c.var.client?.address;
      if (ip === undefined) throw new ApiError('rate_limited', undefined, 60);
      await trx
        .insertInto('content_ip_log')
        .values({ user_id: userId, target_kind: 'app_user', target_id: userId, ip })
        .execute();
      return signedIn(c, trx, userId, host);
    });
    c.header('Set-Cookie', result.cookie);
    return sendJson(c, Me, { user: result.me }, CACHE_PRIVATE);
  });

  v1.post('/auth/signout', async (c) => {
    const session = c.get('session');
    if (session !== undefined) await endSession(deps.db, session.id);
    return noContent(c, CLEAR_COOKIE);
  });

  v1.post('/auth/signout-all', async (c) => {
    const session = requireMember(c);
    await endUserSessions(deps.db, session.user.id);
    return noContent(c, CLEAR_COOKIE);
  });
}
