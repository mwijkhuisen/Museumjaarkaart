import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { enqueueMailCode } from '../mail/payloads.ts';
import type { Locale } from '../mail/templates.ts';
import { hmac, safeEqual, sixDigitCode } from './crypto.ts';
import type { AppKeys } from './keys.ts';

// Email codes (A§9, ADR-0007, P2a design 3): 6 digits, valid 10 minutes, 5 attempts, single use,
// stored only as HMAC(otp_pepper, id ‖ code).
//   - Issuing a code deletes the unused older codes of the same email and purpose, writes the new
//     row and enqueues its mail job (the code sealed) in the caller's transaction. Whether the mail
//     may go out is the worker's decision (design 1), so every caller does the same work.
//   - Checking takes the newest code of that email and purpose and counts the attempt in its own
//     statement before comparing, so parallel guesses cannot pass 5. An email without a code runs
//     the same statements against the nil id and compares against a dummy, so the timing matches.
//   - Consuming marks the code used, conditionally, inside the success transaction.

export type CodePurpose = 'signup' | 'signin' | 'email_change';

export const CODE_TTL_S = 600;
export const CODE_ATTEMPTS = 5;
const NIL = '00000000-0000-0000-0000-000000000000';
const DUMMY = Buffer.alloc(32);

const codeHmac = (keys: AppKeys, id: string, code: string): Buffer => hmac(keys.otp_pepper, 'code', id, code);

/** Issues a code and its sealed mail job. Run it inside a transaction. */
export async function issueCode(
  trx: Db,
  keys: AppKeys,
  a: { email: string; purpose: CodePurpose; locale: Locale; pending?: Readonly<Record<string, string | null>> },
): Promise<void> {
  await trx
    .deleteFrom('email_code')
    .where('email', '=', a.email)
    .where('purpose', '=', a.purpose)
    .where('used_at', 'is', null)
    .execute();
  const { rows } = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(trx);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('uuidv7_failed');
  const code = sixDigitCode();
  await trx
    .insertInto('email_code')
    .values({
      id,
      email: a.email,
      purpose: a.purpose,
      code_hmac: codeHmac(keys, id, code),
      pending: a.pending === undefined ? null : JSON.stringify(a.pending),
      expires_at: sql<Date>`now() + make_interval(secs => ${CODE_TTL_S})`,
    })
    .execute();
  await enqueueMailCode(trx, keys, { emailCodeId: id, code, locale: a.locale });
}

export type CodeCheck = { ok: true; id: string; pending: unknown } | { ok: false };

/** One attempt at the newest code of `email` and `purpose`. Never throws on a wrong code. */
export async function checkCode(
  db: Db,
  keys: AppKeys,
  a: { email: string; purpose: CodePurpose; code: string },
): Promise<CodeCheck> {
  const newest = await db
    .selectFrom('email_code')
    .select('id')
    .where('email', '=', a.email)
    .where('purpose', '=', a.purpose)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const id = newest?.id ?? NIL;
  const row = await db
    .updateTable('email_code')
    .set({ attempts: sql<number>`attempts + 1` })
    .where('id', '=', id)
    .where('attempts', '<', CODE_ATTEMPTS)
    .where('used_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returning(['code_hmac', 'pending'])
    .executeTakeFirst();
  const match = safeEqual(codeHmac(keys, id, a.code), row?.code_hmac ?? DUMMY);
  return match && row !== undefined ? { ok: true, id, pending: row.pending } : { ok: false };
}

/** Marks a checked code used; false when a parallel request used it first. Run it in the success transaction. */
export async function consumeCode(trx: Db, id: string): Promise<boolean> {
  const used = await trx
    .updateTable('email_code')
    .set({ used_at: sql<Date>`now()` })
    .where('id', '=', id)
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return used !== undefined;
}
