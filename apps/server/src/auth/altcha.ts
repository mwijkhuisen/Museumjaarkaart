import { AltchaChallenge } from '@mjk/contracts';
import { createChallenge, type Solution, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/kysely.ts';
import { hmac, sha256 } from './crypto.ts';
import type { AppKeys } from './keys.ts';
import type { SessionHost } from './session.ts';

// ALTCHA (A§9, P2a design 2): proof of work without a puzzle (WCAG 3.3.8), altcha-lib's v2 protocol,
// SHA-256 only (the widget's SHA worker is plain Web Crypto: no WebAssembly under our CSP).
//   - Issued statelessly: GET /auth/altcha writes nothing. The challenge is signed with a secret
//     per host, HMAC(altcha_hmac, host), so a challenge from one host fails on the other.
//   - Spent once: a verified solution is recorded in auth_challenge by the hash of its signature
//     (unique), so a replay hits the key and fails. The purge drops spent rows after they expire.
//   - The widget submits base64(JSON({challenge: {parameters, signature}, solution})).

export const ALTCHA_TTL_S = 300;
/** The difficulty [U P4 tunes it]: a 12-bit hex prefix of one SHA-256, ~4,096 tries, well under a second. */
export const ALTCHA_COST = 1;
export const ALTCHA_KEY_PREFIX = '000';
const PAYLOAD_MAX = 4_096;

const secretFor = (keys: AppKeys, host: SessionHost): string => hmac(keys.altcha_hmac, 'altcha', host).toString('hex');

export async function newChallenge(keys: AppKeys, host: SessionHost): Promise<AltchaChallenge> {
  const challenge = await createChallenge({
    algorithm: 'SHA-256',
    cost: ALTCHA_COST,
    keyPrefix: ALTCHA_KEY_PREFIX,
    deriveKey,
    hmacSignatureSecret: secretFor(keys, host),
    expiresAt: new Date(Date.now() + ALTCHA_TTL_S * 1_000),
  });
  return AltchaChallenge.parse(challenge);
}

const Payload = z.object({
  challenge: AltchaChallenge,
  solution: z.object({
    counter: z
      .number()
      .int()
      .nonnegative()
      .max(2 ** 32),
    derivedKey: z.string().regex(/^[0-9a-f]{2,256}$/),
    time: z.number().nonnegative().optional(),
  }),
});

/**
 * True once for a valid, unexpired solution of a challenge we issued on this host; false for
 * anything else (malformed, forged, expired, the other host's, or already spent). Never throws on
 * input.
 */
export async function spendAltcha(db: Db, keys: AppKeys, host: SessionHost, payload: string): Promise<boolean> {
  if (payload.length > PAYLOAD_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  const p = Payload.safeParse(decoded);
  if (!p.success) return false;
  let verified: boolean;
  try {
    const result = await verifySolution({
      challenge: p.data.challenge,
      solution: p.data.solution as Solution,
      deriveKey,
      hmacSignatureSecret: secretFor(keys, host),
    });
    verified = result.verified && !result.expired;
  } catch {
    return false;
  }
  if (!verified) return false;
  const spent = await db
    .insertInto('auth_challenge')
    .values({
      purpose: 'altcha',
      host,
      value_hash: sha256(p.data.challenge.signature),
      expires_at: new Date(p.data.challenge.parameters.expiresAt * 1_000),
      used_at: sql<Date>`now()`,
    })
    .onConflict((oc) => oc.column('value_hash').doNothing())
    .returning('id')
    .executeTakeFirst();
  return spent !== undefined;
}
