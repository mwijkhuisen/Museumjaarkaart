import { randomBytes } from 'node:crypto';
import {
  type MeUser,
  PASSKEY_MAX,
  PASSKEY_TRANSPORTS,
  type PasskeyAssertion,
  type PasskeyAttestation,
  type PasskeyItem,
  type PasskeyReauthAssertion,
  type PasskeyReauthOptions,
  type PasskeyRegistrationOptions,
  type PasskeySignInOptions,
  type PasskeyTransport,
} from '@mjk/contracts';
import {
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeAttestationObject, isoBase64URL } from '@simplewebauthn/server/helpers';
import { sql } from 'kysely';
import type { SiteDeps } from '../api/middleware/csrf.ts';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { enqueueMailNotice } from '../mail/payloads.ts';
import { hmac, safeEqual, sha256 } from './crypto.ts';
import type { AppKeys } from './keys.ts';
import { BUCKETS, hit, passkeyUserKey, peek } from './limiter.ts';
import { loadUser, settingsOf, toMeUser } from './me.ts';
import { REAUTH_S, type Session, type SessionHost, startSession } from './session.ts';

// Passkeys (P2b; A§9, ADR-0007): @simplewebauthn/server 14.0.3 with our own challenges, counter rule
// and checks around it. The library's facts this module is built on (read in its source):
//   - the `expectedChallenge` callback runs before the origin, RP-ID, UV and signature checks, so it
//     only checks: the challenge is spent after the signature verifies, in the transaction that
//     acts on it;
//   - its counter rule runs before the signature check, on unauthenticated data, so it gets
//     `counter: 0` (which disables it) and we apply the same rule once `verified` is true;
//   - its registration verify checks neither `crossOrigin` nor `topOrigin`, and skips the RP ID
//     when none is passed: we always pass it and refuse a cross-origin ceremony ourselves;
//   - its error messages quote the input, so none is ever logged: every refusal is a fixed code.
//
// Challenges are stateless (P2a's ALTCHA pattern, owner 2026-11-26): 54 bytes,
//   version (1) ‖ kind (1: sign-in, 2: registration) ‖ exp (uint32, Unix seconds) ‖ nonce (16) ‖ tag (32),
// tag = HMAC(altcha_hmac, 'webauthn', version, host, kind, exp ‖ nonce, …binding). The binding is empty for a
// sign-in and (user id, session ref) for a registration, so a challenge works only on its host, for
// its ceremony and, when registering, in the session that asked for it. Options write nothing. A
// challenge is spent once into auth_challenge (purpose `webauthn`, sha256 of its bytes, unique) by an
// INSERT that also checks the expiry with the database's clock, the clock the purge deletes by.

/** A challenge lives 5 minutes; the options' `timeout` says the same to the browser. */
export const WEBAUTHN_TTL_S = 300;
/** Q1a: adding a passkey starts with a sign-in at most this old, so the 10-minute window still holds when it ends. */
export const ADD_REAUTH_S = REAUTH_S - WEBAUTHN_TTL_S;
/** EdDSA, ES256, RS256: passed explicitly, so the library never offers or probes a PQC algorithm. */
export const ALGORITHMS: readonly number[] = [-8, -7, -257];

const VERSION = 1;
const KINDS = { signin: 1, register: 2, reauth: 3 } as const;
type Kind = keyof typeof KINDS;
const CHALLENGE_BYTES = 54;
const TAG_AT = 22;

export type WebAuthnDeps = {
  db: Db;
  keys: AppKeys;
  site: SiteDeps;
  logger: Logger;
  /** Unix seconds; a test seam for the process-clock side of the expiry (the spend uses the database's). */
  nowS?: () => number;
  /**
   * Tests only, never set in production: awaited by verifySignIn after every check on the read row
   * and before the transaction that spends and writes, so a test can change the row in between.
   */
  beforeCommit?: () => Promise<void>;
};

const nowOf = (d: WebAuthnDeps) => (d.nowS ?? (() => Date.now() / 1_000))();

/** The RP ID: `<domain>` on both hosts (a passkey made on one host works on the other). */
export const rpIdOf = (site: SiteDeps): string => site.domain;
/** The one origin a ceremony on this host may come from: never a list of both. */
export const originOf = (site: SiteDeps, host: SessionHost): string =>
  `https://${host === 'admin' ? site.adminHost : site.domain}`;

// The version byte is inside the MAC too (P2b security review, info), so a later format can never
// accept a tag made for this one.
const tagOf = (keys: AppKeys, host: SessionHost, kind: Kind, expNonce: Buffer, binding: readonly string[]) =>
  hmac(keys.altcha_hmac, 'webauthn', String(VERSION), host, String(KINDS[kind]), expNonce, ...binding);

/** A new challenge's bytes for `host`, `kind` and `binding`. */
export function mintChallenge(
  keys: AppKeys,
  host: SessionHost,
  kind: Kind,
  binding: readonly string[],
  nowS: number,
): Buffer {
  const expNonce = Buffer.alloc(20);
  expNonce.writeUInt32BE(Math.floor(nowS) + WEBAUTHN_TTL_S, 0);
  randomBytes(16).copy(expNonce, 4);
  return Buffer.concat([Buffer.from([VERSION, KINDS[kind]]), expNonce, tagOf(keys, host, kind, expNonce, binding)]);
}

export type CheckedChallenge = { bytes: Buffer; expS: number };

/**
 * The challenge in a response's clientDataJSON (base64url) when it is one we minted for this host,
 * kind and binding and not yet expired by the process clock; null otherwise. Writes nothing.
 */
export function checkChallenge(
  keys: AppKeys,
  host: SessionHost,
  kind: Kind,
  binding: readonly string[],
  challenge: string,
  nowS: number,
): CheckedChallenge | null {
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{72}$/.test(challenge)) return null;
  const bytes = Buffer.from(challenge, 'base64url');
  if (bytes.length !== CHALLENGE_BYTES || bytes.toString('base64url') !== challenge) return null;
  if (bytes[0] !== VERSION || bytes[1] !== KINDS[kind]) return null;
  const expNonce = bytes.subarray(2, TAG_AT);
  if (!safeEqual(bytes.subarray(TAG_AT), tagOf(keys, host, kind, expNonce, binding))) return null;
  const expS = expNonce.readUInt32BE(0);
  if (expS <= nowS) return null;
  return { bytes, expS };
}

/**
 * Spends a checked challenge once (true), inside the caller's transaction; false when spent before or
 * expired by the database's clock. The expiry is checked against statement_timestamp(), not now() (the
 * transaction's start, which can lie before a purge that already deleted the spent row); the purge
 * keeps a spent row a minute past its expiry (worker/purge.ts), so a replay never finds it gone
 * (P2b review L4).
 */
export async function spendChallenge(db: Db, host: SessionHost, c: CheckedChallenge): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO auth_challenge (purpose, host, value_hash, expires_at, used_at)
    SELECT 'webauthn', ${host}, ${sha256(c.bytes)}, to_timestamp(${c.expS}::bigint), now()
    WHERE to_timestamp(${c.expS}::bigint) > statement_timestamp()
    ON CONFLICT (value_hash) DO NOTHING
    RETURNING id`.execute(db);
  return rows.length === 1;
}

/** True when the clientDataJSON says `crossOrigin: true` (or cannot be read). The library has already parsed the same bytes. */
function crossOrigin(clientDataJSON: string): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(clientDataJSON, 'base64url'));
    const parsed = JSON.parse(text) as { crossOrigin?: unknown; topOrigin?: unknown };
    return parsed.crossOrigin === true || parsed.topOrigin !== undefined;
  } catch {
    return true;
  }
}

/** A§9's counter rule, the library's own, applied after the signature: a counter in use must grow. */
export const counterRefused = (next: number, stored: number): boolean => (next > 0 || stored > 0) && next <= stored;

const KNOWN: ReadonlySet<string> = new Set(PASSKEY_TRANSPORTS);
/** The browser's transports, kept only when WebAuthn names them, without repeats, at most 8. */
export function knownTransports(list: readonly string[] | undefined): PasskeyTransport[] {
  const out: PasskeyTransport[] = [];
  for (const t of list ?? []) if (KNOWN.has(t) && !out.includes(t as PasskeyTransport)) out.push(t as PasskeyTransport);
  return out.slice(0, 8);
}

// ---- Sign-in --------------------------------------------------------------------------------

/** POST /auth/passkey/options: a discoverable sign-in (no credential list), user verification required. */
export function signInOptions(d: WebAuthnDeps, host: SessionHost): PasskeySignInOptions {
  return {
    challenge: mintChallenge(d.keys, host, 'signin', [], nowOf(d)).toString('base64url'),
    rpId: rpIdOf(d.site),
    timeout: WEBAUTHN_TTL_S * 1_000,
    userVerification: 'required',
  };
}

/** The challenge binding of a session-bound ceremony (a registration or a re-authentication): this member, this session. */
const bindingOf = (session: Session): string[] => [session.user.id, session.ref];

export type ReauthOptionsResult = { ok: true; options: PasskeyReauthOptions } | { ok: false; code: 'conflict' };

/**
 * POST /auth/passkey/reauth/options (P2b, owner 2026-11-27): a re-authentication with one of the
 * signed-in member's own passkeys. The options list only those (`allowCredentials`), so the browser
 * offers no other account's passkey, and the challenge is bound to this member and session. A member
 * without a passkey gets `conflict`.
 */
export async function reauthOptions(
  d: WebAuthnDeps,
  host: SessionHost,
  session: Session,
): Promise<ReauthOptionsResult> {
  const own = await d.db
    .selectFrom('passkey')
    .select(['credential_id', 'transports'])
    .where('user_id', '=', session.user.id)
    .orderBy('created_at')
    .execute();
  if (own.length === 0) return { ok: false, code: 'conflict' };
  return {
    ok: true,
    options: {
      challenge: mintChallenge(d.keys, host, 'reauth', bindingOf(session), nowOf(d)).toString('base64url'),
      rpId: rpIdOf(d.site),
      timeout: WEBAUTHN_TTL_S * 1_000,
      userVerification: 'required',
      allowCredentials: own.map((p) => {
        const transports = knownTransports(p.transports);
        const id = p.credential_id.toString('base64url');
        return transports.length > 0
          ? { id, type: 'public-key' as const, transports }
          : { id, type: 'public-key' as const };
      }),
    },
  };
}

export type SignInResult =
  | { ok: true; cookie: string; me: MeUser }
  | { ok: false; code: 'unauthorized' | 'banned' }
  | { ok: false; code: 'rate_limited'; retryAfterS: number };

/**
 * POST /auth/passkey/verify. Unknown credentials, deleted accounts and, on the admin host, an account
 * whose email is not the Access JWT's all get the same refusal before any signature work; a banned
 * account gets `banned` only after its signature verified (A§9, as for a password). A member past
 * `passkey_user_hour` (30 sign-ins an hour, counted once the signature verified) gets `rate_limited`
 * and no session. Logs fixed codes.
 */
export async function verifySignIn(
  d: WebAuthnDeps,
  req: {
    host: SessionHost;
    credential: PasskeyAssertion | PasskeyReauthAssertion;
    accessEmail: string | undefined;
    sentToken: string | null;
    /**
     * A re-authentication (POST /auth/passkey/reauth/verify): the signed-in member's session. The
     * credential must then be one of this member's, and the challenge one bound to this session; the
     * new session is this member's (a re-authentication never switches accounts).
     */
    reauth?: Session;
  },
): Promise<SignInResult> {
  const { host, credential, reauth } = req;
  const refuse = (reason: string): SignInResult => {
    d.logger.info({ reason }, 'passkey_refused');
    return { ok: false, code: 'unauthorized' };
  };

  const id = Buffer.from(credential.id, 'base64url');
  const row = await d.db
    .selectFrom('passkey as p')
    .innerJoin('app_user as u', 'u.id', 'p.user_id')
    .select([
      'p.credential_id',
      'p.user_id',
      'p.public_key',
      'p.sign_count',
      'p.transports',
      'u.email',
      'u.status',
      'u.webauthn_user_id',
    ])
    .where('p.credential_id', '=', id)
    .executeTakeFirst();
  if (row === undefined || row.status === 'deleted') return refuse('unknown');
  // A re-authentication confirms the signed-in member, never another account.
  if (reauth !== undefined && row.user_id !== reauth.user.id) return refuse('other_member');
  // A§9: an admin-host session only for the Access JWT's own email.
  if (host === 'admin' && req.accessEmail !== String(row.email)) return refuse('unknown');
  // A discoverable credential names its user: it must be the one this credential belongs to. A
  // re-authentication may come without it (the browser was given the credential list), never with another.
  const handle = credential.response.userHandle;
  if (
    handle === undefined ? reauth === undefined : !safeEqual(Buffer.from(handle, 'base64url'), row.webauthn_user_id)
  ) {
    return refuse('user_handle');
  }
  const kind = reauth === undefined ? 'signin' : 'reauth';
  const binding = reauth === undefined ? [] : bindingOf(reauth);

  let checked: CheckedChallenge | null = null;
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: {
        id: credential.id,
        rawId: credential.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          authenticatorData: credential.response.authenticatorData,
          signature: credential.response.signature,
          ...(handle === undefined ? {} : { userHandle: handle }),
        },
        clientExtensionResults: {},
      },
      expectedChallenge: (challenge: string) => {
        checked = checkChallenge(d.keys, host, kind, binding, challenge, nowOf(d));
        return checked !== null;
      },
      expectedOrigin: originOf(d.site, host),
      expectedRPID: rpIdOf(d.site),
      expectedType: 'webauthn.get',
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(row.public_key),
        counter: 0, // the library's pre-signature counter check off; ours follows the signature
        transports: row.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    return refuse(checked === null ? 'challenge' : 'verify');
  }
  const spend: CheckedChallenge | null = checked;
  const info = verification.authenticationInfo;
  if (!verification.verified || spend === null || !info.userVerified) return refuse('verify');
  if (crossOrigin(credential.response.clientDataJSON)) return refuse('cross_origin');

  const stored = Number(row.sign_count);
  if (counterRefused(info.newCounter, stored)) {
    // A cloned authenticator, or one replaying an old state (A§16.2): never the key, id or counters.
    d.logger.warn({}, 'passkey_counter');
    return { ok: false, code: 'unauthorized' };
  }
  if (row.status === 'banned') return { ok: false, code: 'banned' };
  if (row.status !== 'active') return refuse('unknown');
  // P2b review L1: a per-member cap on successful sign-ins, keyed by an HMAC of the user id.
  const perUser = await hit(d.db, BUCKETS.passkeyUserHour, passkeyUserKey(d.keys, row.user_id));
  if (!perUser.allowed) {
    d.logger.warn({ bucket: BUCKETS.passkeyUserHour.name }, 'rate_limited');
    return { ok: false, code: 'rate_limited', retryAfterS: perUser.retryAfterS };
  }
  if (d.beforeCommit !== undefined) await d.beforeCommit();

  return d.db.transaction().execute(async (trx): Promise<SignInResult> => {
    if (!(await spendChallenge(trx, host, spend))) return refuse('replay');
    // Compare-and-set on the counter just checked: a concurrent use or a deletion since the read wins.
    const updated = await trx
      .updateTable('passkey')
      .set({ sign_count: info.newCounter, backed_up: info.credentialBackedUp, last_used_at: sql<Date>`now()` })
      .where('credential_id', '=', id)
      .where('user_id', '=', row.user_id)
      .where('sign_count', '=', row.sign_count)
      .returning('credential_id')
      .executeTakeFirst();
    if (updated === undefined) return refuse('changed');
    const s = await startSession(trx, { userId: row.user_id, host, method: 'passkey', sentToken: req.sentToken });
    const user = await loadUser(trx, row.user_id);
    if (user === undefined) throw new Error('user_vanished');
    return { ok: true, cookie: s.cookie, me: toMeUser(user) };
  });
}

// ---- Registration ---------------------------------------------------------------------------

/**
 * The attestation statements the library may see (P2b security review H1): `none` with an empty
 * statement, or `packed` self attestation (`alg` and `sig` only, signed by the new credential's own
 * key). Every other format makes @simplewebauthn/server 14.0.3 walk an X.509 chain the client chose:
 * for `android-key` it validates the submitted `x5c` against its own last certificate before the
 * Google-root check, and validateCertificatePath fetches each CRL Distribution Point URL with
 * `globalThis.fetch` (redirects followed, no timeout, the whole body read), so any signed-in member
 * could make the api fetch a URL of theirs (SSRF, the VM's address, memory). We ask for attestation
 * `none`, and a browser then replaces every other statement with `none` (WebAuthn L3 §5.1.3), so no
 * browser is refused. The check decodes the same bytes the library decodes, with its own helpers,
 * before the library sees them; anything else, an undecodable object included, is refused.
 */
export function attestationAllowed(attestationObject: string): boolean {
  try {
    const decoded: unknown = decodeAttestationObject(isoBase64URL.toBuffer(attestationObject));
    if (!(decoded instanceof Map)) return false;
    const fmt: unknown = decoded.get('fmt');
    const stmt: unknown = decoded.get('attStmt');
    if (!(stmt instanceof Map)) return false;
    if (fmt === 'none') return stmt.size === 0;
    if (fmt === 'packed') {
      return stmt.size === 2 && typeof stmt.get('alg') === 'number' && stmt.get('sig') instanceof Uint8Array;
    }
    return false;
  } catch {
    return false;
  }
}

export type RegistrationOptionsResult =
  | { ok: true; options: PasskeyRegistrationOptions }
  | { ok: false; code: 'conflict' }
  | { ok: false; code: 'rate_limited'; retryAfterS: number };

/** POST /me/passkeys/options for the session's member (the route checks the re-authentication). */
export async function registrationOptions(
  d: WebAuthnDeps,
  host: SessionHost,
  session: Session,
): Promise<RegistrationOptionsResult> {
  const user = await d.db
    .selectFrom('app_user')
    .select(['webauthn_user_id', 'handle'])
    .where('id', '=', session.user.id)
    .executeTakeFirstOrThrow();
  const existing = await d.db
    .selectFrom('passkey')
    .select(['credential_id', 'transports'])
    .where('user_id', '=', session.user.id)
    .orderBy('created_at')
    .execute();
  if (existing.length >= PASSKEY_MAX) return { ok: false, code: 'conflict' };
  // P2b review M1: the day's adds used up → refused here, before the browser's dialog, so no device
  // stores a passkey the add would then refuse (the add counts it, under the member's row lock).
  const day = BUCKETS.passkeyAddUserDay;
  if ((await peek(d.db, day, passkeyUserKey(d.keys, session.user.id))) >= day.limit) {
    d.logger.warn({ bucket: day.name }, 'rate_limited');
    const nowS = Math.floor(Date.now() / 1_000);
    return { ok: false, code: 'rate_limited', retryAfterS: Math.max(1, day.windowS - (nowS % day.windowS)) };
  }
  const handle = String(user.handle);
  const o = await generateRegistrationOptions({
    rpName: rpIdOf(d.site),
    rpID: rpIdOf(d.site),
    // Q2: the handle, never the email; the user id is the random webauthn_user_id.
    userName: handle,
    userDisplayName: handle,
    userID: new Uint8Array(user.webauthn_user_id),
    challenge: new Uint8Array(mintChallenge(d.keys, host, 'register', bindingOf(session), nowOf(d))),
    timeout: WEBAUTHN_TTL_S * 1_000,
    attestationType: 'none',
    excludeCredentials: existing.map((e) => ({
      id: e.credential_id.toString('base64url'),
      transports: knownTransports(e.transports),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [...ALGORITHMS],
  });
  return {
    ok: true,
    options: {
      challenge: o.challenge,
      rp: { id: rpIdOf(d.site), name: rpIdOf(d.site) },
      user: { id: o.user.id, name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams.map((p) => ({ alg: p.alg, type: 'public-key' as const })),
      timeout: WEBAUTHN_TTL_S * 1_000,
      attestation: 'none',
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => {
        const transports = knownTransports(c.transports);
        return transports.length > 0
          ? { id: c.id, type: 'public-key' as const, transports }
          : { id: c.id, type: 'public-key' as const };
      }),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      extensions: { credProps: true },
    },
  };
}

export type RegistrationResult =
  | { ok: true; item: PasskeyItem }
  | { ok: false; code: 'invalid' | 'conflict' }
  | { ok: false; code: 'rate_limited'; retryAfterS: number };

const UNIQUE_VIOLATION = '23505';

/**
 * POST /me/passkeys: verifies the new credential for the session's member and stores it. A failed
 * ceremony is `invalid`; a credential stored before (by anyone) or the member's 21st is `conflict`.
 */
export async function verifyRegistration(
  d: WebAuthnDeps,
  req: { host: SessionHost; session: Session; credential: PasskeyAttestation; name: string | undefined },
): Promise<RegistrationResult> {
  const { host, session, credential } = req;
  const refuse = (reason: string): RegistrationResult => {
    d.logger.info({ reason }, 'passkey_register_refused');
    return { ok: false, code: 'invalid' };
  };
  // H1: before the library, so no X.509 path is ever walked and no CRL fetched (above).
  if (!attestationAllowed(credential.response.attestationObject)) return refuse('attestation_format');

  let checked: CheckedChallenge | null = null;
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: {
        id: credential.id,
        rawId: credential.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          attestationObject: credential.response.attestationObject,
          ...(credential.response.transports === undefined ? {} : { transports: credential.response.transports }),
        },
        clientExtensionResults: {},
      },
      expectedChallenge: (challenge: string) => {
        checked = checkChallenge(d.keys, host, 'register', bindingOf(session), challenge, nowOf(d));
        return checked !== null;
      },
      expectedOrigin: originOf(d.site, host),
      expectedRPID: rpIdOf(d.site),
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...ALGORITHMS],
    });
  } catch {
    return refuse(checked === null ? 'challenge' : 'verify');
  }
  const spend: CheckedChallenge | null = checked;
  const info = verification.registrationInfo;
  if (!verification.verified || info === undefined || spend === null || !info.userVerified) return refuse('verify');
  if (crossOrigin(credential.response.clientDataJSON)) return refuse('cross_origin');
  // residentKey 'required': an authenticator that says it made a non-discoverable one could never sign in.
  if (credential.rk === false) return refuse('not_discoverable');
  // The id the authenticator will sign in with is the one in its authenticator data.
  if (info.credential.id !== credential.id) return refuse('id_mismatch');

  const transports = knownTransports(credential.response.transports);
  try {
    return await d.db.transaction().execute(async (trx): Promise<RegistrationResult> => {
      // One registration at a time per member, so the cap holds under a race.
      await trx
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', session.user.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const { count } = await trx
        .selectFrom('passkey')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', session.user.id)
        .executeTakeFirstOrThrow();
      if (Number(count) >= PASSKEY_MAX) return { ok: false, code: 'conflict' };
      if (!(await spendChallenge(trx, host, spend))) return refuse('replay');
      // P2b review M1: every added passkey sends a notice that may use the mail budget's reserve, so adds
      // are limited per member and (UTC) day, and removing one frees no slot. Counted under the row lock
      // above, after the spend (a replay counts nothing); a failed insert rolls the count back.
      const added = await hit(trx, BUCKETS.passkeyAddUserDay, passkeyUserKey(d.keys, session.user.id));
      if (!added.allowed) {
        d.logger.warn({ bucket: BUCKETS.passkeyAddUserDay.name }, 'rate_limited');
        return { ok: false, code: 'rate_limited', retryAfterS: added.retryAfterS };
      }
      const row = await trx
        .insertInto('passkey')
        .values({
          credential_id: Buffer.from(info.credential.id, 'base64url'),
          user_id: session.user.id,
          public_key: Buffer.from(info.credential.publicKey),
          sign_count: info.credential.counter,
          transports,
          backed_up: info.credentialBackedUp,
          name: req.name ?? null,
        })
        .returning(['ref', 'name', 'created_at', 'last_used_at', 'backed_up'])
        .executeTakeFirstOrThrow();
      // The member's alarm for a passkey planted through a stolen session (A§16.2; owner, 2026-11-27): a fixed
      // notice to the account's address, sealed into the job and committed with the passkey (a rollback drops it).
      await enqueueMailNotice(trx, d.keys, {
        userId: session.user.id,
        to: session.user.email,
        locale: settingsOf(session.user.settings).locale,
        notice: 'passkey_added',
      });
      return { ok: true, item: toPasskeyItem(row) };
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === UNIQUE_VIOLATION) return { ok: false, code: 'conflict' };
    throw err;
  }
}

/** A passkey row as the account page lists it (A§14): never the key, the id, the transports or the counter. */
export function toPasskeyItem(r: {
  ref: string;
  name: string | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
  backed_up: boolean;
}): PasskeyItem {
  const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
  return {
    ref: r.ref,
    name: r.name,
    created_at: iso(r.created_at),
    last_used_at: r.last_used_at === null ? null : iso(r.last_used_at),
    backed_up: r.backed_up,
  };
}
