import { sql } from 'kysely';
import { ApiError } from '../api/errors.ts';
import type { ClientAddress } from '../api/middleware/client-address.ts';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { PHOTOS_PER_DAY } from '../media/limits.ts';
import { hmac } from './crypto.ts';
import type { AppKeys } from './keys.ts';

// The Postgres rate limiter (A§9): fixed windows in `rate_limit`, one atomic upsert per hit. Keys are
// IP prefixes (/24, /56, /48), an email HMAC or a user-id HMAC, never an address or an id (invariant 8). A refusal logs only
// the bucket's name.

export type Bucket = { readonly name: string; readonly limit: number; readonly windowS: number };

/** A§9's limits [U: P2a and the beta tune them]. */
export const BUCKETS = {
  codeEmailPrefix: { name: 'code_email_prefix', limit: 3, windowS: 900 }, // code request per (email, IP prefix)
  codeEmailDay: { name: 'code_email_day', limit: 20, windowS: 86_400 }, // per email (the mail-bomb cap)
  codePrefix: { name: 'code_prefix', limit: 20, windowS: 3_600 }, // code requests, sign-ups and email changes per IP prefix
  verifyFailPrefix: { name: 'verify_fail_prefix', limit: 30, windowS: 3_600 }, // failed code checks per IP prefix
  verifyFailSite: { name: 'verify_fail_site', limit: 500, windowS: 3_600 }, // site-wide failures: above it verify also needs ALTCHA (a threshold, not a refusal)
  passwordEmail: { name: 'password_email', limit: 5, windowS: 900 }, // password sign-ins per email
  passwordPrefix: { name: 'password_prefix', limit: 20, windowS: 3_600 }, // password sign-ins per IP prefix
  passwordSet: { name: 'password_set', limit: 5, windowS: 900 }, // PUT /me/password per member (passkeyUserKey), before the hash
  signupSiteDay: { name: 'signup_site_day', limit: 20, windowS: 86_400 }, // anonymous-triggered mails a day, site-wide (A§17.7)
  passkeyFailPrefix: { name: 'passkey_fail_prefix', limit: 30, windowS: 3_600 }, // failed passkey sign-ins per IP prefix (P2b Q4)
  passkeyUserHour: { name: 'passkey_user_hour', limit: 30, windowS: 3_600 }, // successful passkey sign-ins per member (P2b review L1)
  passkeyRegisterUser: { name: 'passkey_register_user', limit: 10, windowS: 3_600 }, // failed passkey registrations per member (P2b review L2)
  passkeyAddUserDay: { name: 'passkey_add_user_day', limit: 5, windowS: 86_400 }, // passkeys added per member a day: each sends a notice mail (P2b review M1)
  importUserHour: { name: 'import_user_hour', limit: 10, windowS: 3_600 }, // import uploads per member (a user-id HMAC; A§14, P2c)
  exportUserDay: { name: 'export_user_day', limit: 3, windowS: 86_400 }, // export requests per member (a user-id HMAC; P2c Q5: each costs a mail)
  reviewUserDay: { name: 'review_user_day', limit: 20, windowS: 86_400 }, // review writes (POST and PATCH /reviews) per member (a user-id HMAC; A§9, P3a)
  photoUserDay: { name: 'photo_user_day', limit: PHOTOS_PER_DAY, windowS: 86_400 }, // photos started (POST /uploads) per member a day (a user-id HMAC; A§9, A§12, P3b)
} as const satisfies Record<string, Bucket>;

export type Hit = {
  readonly count: number;
  readonly allowed: boolean;
  readonly retryAfterS: number;
  readonly windowStart: Date;
};

type Opts = { at?: Date };

function checkKey(key: string): void {
  if (key.length < 1 || key.length > 100) throw new Error('limiter_key');
}

// The window start of instant `at` (a bound timestamptz, or the database's now()) as SQL.
const windowStart = (at: Date | null, windowS: number) =>
  sql`to_timestamp(floor(extract(epoch from COALESCE(${at}::timestamptz, now())) / ${windowS}::int) * ${windowS}::int)`;

/** One atomic fixed-window hit. A refused hit still counts: a flood keeps its bucket full. */
export async function hit(db: Db, bucket: Bucket, key: string, opts: Opts = {}): Promise<Hit> {
  checkKey(key);
  const at = opts.at ?? null;
  const { rows } = await sql<{ count: number; window_start: Date; retry: number }>`
    INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
    VALUES (${bucket.name}, ${key}, ${windowStart(at, bucket.windowS)},
            ${windowStart(at, bucket.windowS)} + ${bucket.windowS}::int * interval '1 second', 1)
    ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = rate_limit.count + 1
    RETURNING count, window_start,
      extract(epoch from window_end - COALESCE(${at}::timestamptz, now()))::float8 AS retry`.execute(db);
  const row = rows[0];
  if (!row) throw new Error('limiter_no_row');
  return {
    count: row.count,
    allowed: row.count <= bucket.limit,
    retryAfterS: Math.max(1, Math.ceil(row.retry)),
    windowStart: row.window_start,
  };
}

/** Gives back one slot in the exact row a hit counted, never below 0 (reserve, compare, refund on success). */
export async function refund(db: Db, bucket: Bucket, key: string, windowStart: Date): Promise<void> {
  checkKey(key);
  await sql`UPDATE rate_limit SET count = GREATEST(count - 1, 0)
    WHERE bucket = ${bucket.name} AND key = ${key} AND window_start = ${windowStart}::timestamptz`.execute(db);
}

/** The current window's count (0 when there is no row). */
export async function peek(db: Db, bucket: Bucket, key: string, opts: Opts = {}): Promise<number> {
  checkKey(key);
  const { rows } = await sql<{ count: number }>`SELECT count FROM rate_limit
    WHERE bucket = ${bucket.name} AND key = ${key}
      AND window_start = ${windowStart(opts.at ?? null, bucket.windowS)}`.execute(db);
  return rows[0]?.count ?? 0;
}

/** The key for an email (normalised by the contract): the table never holds an address. */
export const emailKey = (keys: AppKeys, email: string): string => hmac(keys.otp_pepper, 'rl', email).toString('hex');

/** The key for a member's own buckets: an HMAC of the scope and the user id, never the id in clear (invariant 8). */
export const userKey = (
  keys: AppKeys,
  scope: 'passkey' | 'import' | 'export' | 'review' | 'photo',
  userId: string,
): string => hmac(keys.otp_pepper, 'rl', scope, userId).toString('hex');

/** The key for a member's passkey buckets. */
export const passkeyUserKey = (keys: AppKeys, userId: string): string => userKey(keys, 'passkey', userId);

/** A per-email key of one host class: a public-host flood never fills the admin host's buckets (A§9, A§16.2). */
export const hostEmailKey = (keys: AppKeys, host: 'public' | 'admin', email: string, prefix?: string): string =>
  emailKey(keys, prefix === undefined ? `${host}\n${email}` : `${host}\n${email}\n${prefix}`);

/** The per-email code-request limits of sign-up, /auth/code and /me/email (A§9 table), keyed by host class. */
export async function codeEmailLimits(
  db: Db,
  logger: Logger,
  keys: AppKeys,
  host: 'public' | 'admin',
  client: ClientAddress | undefined,
  email: string,
): Promise<void> {
  const pair = await hit(db, BUCKETS.codeEmailPrefix, hostEmailKey(keys, host, email, client?.prefix ?? ''));
  enforce(logger, BUCKETS.codeEmailPrefix, pair);
  enforce(logger, BUCKETS.codeEmailDay, await hit(db, BUCKETS.codeEmailDay, hostEmailKey(keys, host, email)));
}

export type IpKey = { key: string; factor: 1 | 4 };

/** IPv4: the /24. IPv6: the /56, plus the /48 at 4x the limit. Null when the client is unknown. */
export function ipKeys(client: ClientAddress | undefined): IpKey[] | null {
  if (client === undefined) return null;
  const keys: IpKey[] = [{ key: client.prefix, factor: 1 }];
  if (client.prefix48 !== null) keys.push({ key: client.prefix48, factor: 4 });
  return keys;
}

/** Hits every prefix key; the most restrictive answer. Null when the client is unknown (refuse). */
export async function hitIp(
  db: Db,
  bucket: Bucket,
  client: ClientAddress | undefined,
  opts: Opts = {},
): Promise<Hit | null> {
  const keys = ipKeys(client);
  if (keys === null) return null;
  const hits = await Promise.all(
    keys.map(async ({ key, factor }) => {
      const limit = bucket.limit * factor;
      return { limit, h: await hit(db, { ...bucket, limit }, key, opts) };
    }),
  );
  let worst = hits[0] as (typeof hits)[number];
  for (const x of hits) if (x.h.count / x.limit > worst.h.count / worst.limit) worst = x;
  return {
    ...worst.h,
    allowed: hits.every((x) => x.h.allowed),
    retryAfterS: Math.max(...hits.map((x) => x.h.retryAfterS)),
  };
}

/** Throws the 429 when the hit is refused or the client unknown; logs only the bucket's name. */
export function enforce(logger: Logger, bucket: Bucket, h: Hit | null): void {
  if (h?.allowed) return;
  logger.warn(h === null ? { bucket: bucket.name, reason: 'client_unknown' } : { bucket: bucket.name }, 'rate_limited');
  throw new ApiError('rate_limited', undefined, h?.retryAfterS ?? 60);
}
