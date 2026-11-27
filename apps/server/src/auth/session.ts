import { type Kysely, sql } from 'kysely';
import { ApiError } from '../api/errors.ts';
import type { DB } from '../db/types.ts';
import { newSessionToken, sessionTokenHash } from './crypto.ts';

// Own sessions, Lucia's `auth_session` approach (A§9, ADR-0007):
//   - a 32-byte random token in the cookie; the row id is sha256 of its bytes, so the database never
//     holds a usable token;
//   - a session works only on the host class that created it (`public` or `admin`), and only while
//     its user is `active` (a ban also deletes the rows, A§9);
//   - sliding expiry: when `last_used_at` is over an hour old, one UPDATE moves `last_used_at` to now
//     and `expires_at` to now + the idle lifetime, never past the absolute one. That is at most one
//     write an hour per session, and the session list is never more than an hour stale;
//   - every comparison uses the database's clock (tests backdate rows), never the process's.

type AnyDb = Kysely<DB>;

export const SESSION_COOKIE = '__Host-mjk_sid';

export type SessionHost = 'public' | 'admin';
export type SessionMethod = 'code' | 'password' | 'passkey';

/** A§9 lifetimes [U: the beta tunes them], in seconds: idle (sliding) and absolute, per host. */
export const LIFETIME: Readonly<Record<SessionHost, { idleS: number; absoluteS: number }>> = {
  public: { idleS: 30 * 86_400, absoluteS: 180 * 86_400 },
  admin: { idleS: 12 * 3_600, absoluteS: 7 * 86_400 },
};
/** A session row is touched (slid) at most once per this many seconds. */
export const TOUCH_AFTER_S = 3_600;
/** A§9: a sensitive change needs a sign-in or code on this session within the last 10 minutes. */
export const REAUTH_S = 600;

export type SessionUser = {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  role: 'user' | 'moderator' | 'admin';
  settings: unknown;
  terms_version: string;
  has_password: boolean;
  created_at: Date;
};

export type Session = {
  /** sha256(token): the row id. Never sent to a client or a log. */
  id: Buffer;
  ref: string;
  host: SessionHost;
  method: SessionMethod;
  /** The last sign-in or code on this session is within REAUTH_S (by the database's clock). */
  reauthFresh: boolean;
  user: SessionUser;
};

const secs = (s: number) => sql<string>`make_interval(secs => ${s})`;

/** The Set-Cookie value for a new session: exactly A§9's attributes plus Max-Age (the absolute lifetime). */
export function sessionCookie(token: string, host: SessionHost): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${LIFETIME[host].absoluteS}`;
}

/** The Set-Cookie value that removes the cookie (sign-out). */
export const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * The session token from a Cookie header, or null. The first `__Host-mjk_sid` counts; its format
 * is checked by sessionTokenHash. No other cookie is read or kept.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined || header.length > 8_192) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Starts a session for `userId` on `host` and returns the token and its Set-Cookie value. A
 * sign-in first deletes the row of any session cookie sent with the request (A§9: a new token at
 * every sign-in, so a planted cookie never becomes a signed-in one). Run it inside the sign-in's
 * transaction.
 */
export async function startSession(
  db: AnyDb,
  opts: { userId: string; host: SessionHost; method: SessionMethod; sentToken: string | null },
): Promise<{ token: string; cookie: string }> {
  if (opts.sentToken !== null) {
    const sent = sessionTokenHash(opts.sentToken);
    if (sent !== null) await db.deleteFrom('session').where('id', '=', sent).execute();
  }
  const token = newSessionToken();
  const id = sessionTokenHash(token);
  if (id === null) throw new Error('session_token_invalid');
  const { idleS, absoluteS } = LIFETIME[opts.host];
  await db
    .insertInto('session')
    .values({
      id,
      user_id: opts.userId,
      host: opts.host,
      method: opts.method,
      expires_at: sql<Date>`now() + ${secs(idleS)}`,
      absolute_expires_at: sql<Date>`now() + ${secs(absoluteS)}`,
    })
    .execute();
  return { token, cookie: sessionCookie(token, opts.host) };
}

/** The live session for `token` on `host`, slid when due; null when absent, expired, on another host or the user is not active. */
export async function loadSession(db: AnyDb, token: string, host: SessionHost): Promise<Session | null> {
  const id = sessionTokenHash(token);
  if (id === null) return null;
  const row = await db
    .selectFrom('session as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      's.ref',
      's.host',
      's.method',
      'u.id as user_id',
      'u.email',
      'u.handle',
      'u.display_name',
      'u.role',
      'u.settings',
      'u.terms_version',
      'u.created_at',
      sql<boolean>`u.password_hash IS NOT NULL`.as('has_password'),
      sql<boolean>`s.reauth_at > now() - ${secs(REAUTH_S)}`.as('reauth_fresh'),
      sql<boolean>`s.last_used_at < now() - ${secs(TOUCH_AFTER_S)}`.as('stale'),
    ])
    .where('s.id', '=', id)
    .where('s.host', '=', host)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('s.absolute_expires_at', '>', sql<Date>`now()`)
    .where('u.status', '=', 'active')
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.stale) {
    await db
      .updateTable('session')
      .set({
        last_used_at: sql<Date>`now()`,
        expires_at: sql<Date>`least(now() + ${secs(LIFETIME[host].idleS)}, absolute_expires_at)`,
      })
      .where('id', '=', id)
      .execute();
  }
  return {
    id,
    ref: row.ref,
    host: row.host as SessionHost,
    method: row.method as SessionMethod,
    reauthFresh: row.reauth_fresh,
    user: {
      id: row.user_id,
      email: String(row.email),
      handle: String(row.handle),
      display_name: row.display_name,
      role: row.role as SessionUser['role'],
      settings: row.settings,
      terms_version: row.terms_version,
      has_password: row.has_password,
      created_at: row.created_at as Date,
    },
  };
}

/** Sign-out: this session's row. */
export async function endSession(db: AnyDb, id: Buffer): Promise<void> {
  await db.deleteFrom('session').where('id', '=', id).execute();
}

/** Every session of a user ("sign out everywhere", a ban), or every one but `keep` (an email or password change). */
export async function endUserSessions(db: AnyDb, userId: string, keep?: Buffer): Promise<void> {
  let q = db.deleteFrom('session').where('user_id', '=', userId);
  if (keep !== undefined) q = q.where('id', '!=', keep);
  await q.execute();
}

/** A§9 re-authentication: 403 `reauth_required` unless this session signed in or took a code within 10 minutes. */
export function requireReauth(session: Session): void {
  if (!session.reauthFresh) throw new ApiError('reauth_required');
}

/**
 * A stricter re-authentication (P2b Q1a): 403 `reauth_required` unless this session signed in or took
 * a code within `withinS` seconds (at most REAUTH_S), by the database's clock.
 */
export async function requireReauthWithin(db: AnyDb, session: Session, withinS: number): Promise<void> {
  requireReauth(session);
  const row = await db
    .selectFrom('session')
    .select(sql<boolean>`reauth_at > now() - ${secs(Math.min(withinS, REAUTH_S))}`.as('fresh'))
    .where('id', '=', session.id)
    .executeTakeFirst();
  if (row?.fresh !== true) throw new ApiError('reauth_required');
}
