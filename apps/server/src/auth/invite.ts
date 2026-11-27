import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { hmac, newInviteCode } from './crypto.ts';
import type { AppKeys } from './keys.ts';

// Invite codes (A§9): 16 characters of Crockford base32 (80 bits), shown once and stored only as
// HMAC(invite_pepper, code) of the normalised code. `uses` is incremented with a conditional UPDATE
// in the transaction that creates the account, so parallel sign-ups on a single-use invite create
// exactly one account; a used-up or expired invite makes the code verify fail with 403.

export const INVITE_DEFAULT_DAYS = 14;

export const inviteHmac = (keys: AppKeys, normalisedCode: string): Buffer =>
  hmac(keys.invite_pepper, 'invite', normalisedCode);

/** A new invite; the code is returned once and never stored. Run it inside the caller's transaction. */
export async function createInvite(
  db: Db,
  keys: AppKeys,
  a: { maxUses: number; days: number; note?: string | null; createdBy?: string | null },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = newInviteCode();
  const row = await db
    .insertInto('invite')
    .values({
      code_hmac: inviteHmac(keys, code),
      max_uses: a.maxUses,
      note: a.note ?? null,
      created_by: a.createdBy ?? null,
      expires_at: sql<Date>`now() + make_interval(days => ${a.days})`,
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, code, expiresAt: row.expires_at as Date };
}

/** The id of a usable invite (unused uses left, not expired) for this normalised code, or undefined. */
export async function findUsableInvite(db: Db, keys: AppKeys, normalisedCode: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('invite')
    .select('id')
    .where('code_hmac', '=', inviteHmac(keys, normalisedCode))
    .whereRef('uses', '<', 'max_uses')
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return row?.id;
}

/** Takes one use of the invite; false when it is used up or expired. Run it in the account's transaction. */
export async function consumeInvite(trx: Db, id: string): Promise<boolean> {
  const row = await trx
    .updateTable('invite')
    .set({ uses: sql<number>`uses + 1`, used_at: sql<Date>`now()` })
    .where('id', '=', id)
    .whereRef('uses', '<', 'max_uses')
    .where('expires_at', '>', sql<Date>`now()`)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}
