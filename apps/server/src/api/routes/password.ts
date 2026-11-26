import { Me, PasswordSetRequest, PasswordSignInRequest } from '@mjk/contracts';
import type { Context } from 'hono';
import {
  dummyVerify,
  HashBusy,
  type HashGate,
  hashGate,
  hashPassword,
  needsRehash,
  parsePhc,
  verifyPassword,
} from '../../auth/argon2.ts';
import { BUCKETS, emailKey, enforce, hit, hitIp } from '../../auth/limiter.ts';
import { loadUser, toMeUser } from '../../auth/me.ts';
import { endUserSessions, readSessionCookie, requireReauth, startSession } from '../../auth/session.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { accessEmail, hostClass, requireMember } from '../middleware/session.ts';
import { sendJson } from '../respond.ts';

// Password sign-in and the member's password (A§9 "Sign-in by password", A§14, A§16.2 "Credential
// stuffing", "Account takeover"). Every failed sign-in is the same 401 after exactly one argon2
// verify through the gate (a dummy for an unknown email, an account without a password, a deleted
// account and an admin-host email other than the Access JWT's), so neither the body nor the timing
// tells them apart. A wrong password on a banned account is that 401 too; only the right one is 403.
// Nothing here logs the email, the password, the token or the cookie.

/** `hashGate` is a test seam: the process-wide gate unless a test injects its own. */
export type PasswordDeps = ApiDeps & { hashGate?: HashGate };

/** HashBusy (no gate permit within its wait) → 429 with Retry-After: 2; anything else rethrows. */
async function gated<T>(deps: PasswordDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HashBusy)) throw err;
    deps.logger.warn({}, 'hash_busy');
    throw new ApiError('rate_limited', undefined, 2);
  }
}

const noContent = (c: Context<ApiEnv>) => {
  c.header('Cache-Control', CACHE_PRIVATE);
  return c.body(null, 204);
};

export function mountPassword(v1: ApiApp, deps: PasswordDeps): void {
  const { keys, site } = deps;
  if (keys === undefined || site === undefined) throw new Error('password routes need keys and site');
  const gate = deps.hashGate ?? hashGate;

  v1.post('/auth/password', async (c) => {
    const { email, password } = await readJson(c, PasswordSignInRequest);

    const [ipHit, emailHit] = await Promise.all([
      hitIp(deps.db, BUCKETS.passwordPrefix, c.var.client),
      hit(deps.db, BUCKETS.passwordEmail, emailKey(keys, email)),
    ]);
    enforce(deps.logger, BUCKETS.passwordPrefix, ipHit);
    enforce(deps.logger, BUCKETS.passwordEmail, emailHit);

    const host = hostClass(c, site);
    // A§9: an admin-host session only for the Access JWT's own email; any other is an unknown email.
    const account =
      host === 'admin' && accessEmail(c) !== email
        ? undefined
        : await deps.db
            .selectFrom('app_user')
            .select(['id', 'password_hash', 'status'])
            .where('email', '=', email)
            .executeTakeFirst();
    const hash = account?.password_hash ?? null;

    // One verify on every path. An unparseable stored hash would skip it, so it takes the dummy too.
    if (account === undefined || hash === null || parsePhc(hash) === null) {
      await gated(deps, () => dummyVerify(password, gate));
      throw new ApiError('unauthorized');
    }
    if (!(await gated(deps, () => verifyPassword(password, hash, gate)))) throw new ApiError('unauthorized');
    if (account.status === 'banned') throw new ApiError('banned');
    if (account.status !== 'active') throw new ApiError('unauthorized');

    if (needsRehash(hash)) {
      try {
        const upgraded = await hashPassword(password, undefined, gate);
        // Only over the hash just verified: a concurrent password change wins.
        await deps.db
          .updateTable('app_user')
          .set({ password_hash: upgraded })
          .where('id', '=', account.id)
          .where('password_hash', '=', hash)
          .execute();
      } catch (err) {
        // The gate is full: keep the old hash this time, the next sign-in upgrades it.
        if (!(err instanceof HashBusy)) throw err;
        deps.logger.warn({}, 'password_rehash_skipped');
      }
    }

    const { cookie, user } = await deps.db.transaction().execute(async (trx) => {
      const s = await startSession(trx, {
        userId: account.id,
        host,
        method: 'password',
        sentToken: readSessionCookie(c.req.header('cookie')),
      });
      return { cookie: s.cookie, user: await loadUser(trx, account.id) };
    });
    if (user === undefined) throw new Error('user_vanished');
    c.header('Set-Cookie', cookie);
    return sendJson(c, Me, { user: toMeUser(user) }, CACHE_PRIVATE);
  });

  v1.put('/me/password', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    const { password } = await readJson(c, PasswordSetRequest);
    const hash = await gated(deps, () => hashPassword(password, undefined, gate));
    await deps.db.transaction().execute(async (trx) => {
      await trx.updateTable('app_user').set({ password_hash: hash }).where('id', '=', session.user.id).execute();
      await endUserSessions(trx, session.user.id, session.id);
    });
    return noContent(c);
  });

  v1.delete('/me/password', async (c) => {
    const session = requireMember(c);
    requireReauth(session);
    await deps.db.transaction().execute(async (trx) => {
      await trx.updateTable('app_user').set({ password_hash: null }).where('id', '=', session.user.id).execute();
      await endUserSessions(trx, session.user.id, session.id);
    });
    return noContent(c);
  });
}
