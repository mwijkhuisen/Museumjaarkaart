import type { Db } from '../db/kysely.ts';

/**
 * Bans a member (A§9): status, every session and the audit row commit together, so a ban takes
 * effect at once. The reason lives only in `app_user.ban_reason`; the audit detail holds codes
 * and ids only (A§8). Returns whether the user existed. No route uses it before P3c.
 */
export async function banUser(
  db: Db,
  a: {
    userId: string;
    until: Date | null;
    reason: string;
    actorId: string | null;
    actorKind: 'moderator' | 'admin' | 'system';
  },
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const user = await trx
      .updateTable('app_user')
      .set({ status: 'banned', banned_until: a.until, ban_reason: a.reason })
      .where('id', '=', a.userId)
      .returning('id')
      .executeTakeFirst();
    if (user === undefined) return false;
    await trx.deleteFrom('session').where('user_id', '=', a.userId).execute();
    await trx
      .insertInto('audit_log')
      .values({
        actor_id: a.actorId,
        actor_kind: a.actorKind,
        action: 'user.ban',
        target_kind: 'app_user',
        target_id: a.userId,
        detail: JSON.stringify({ permanent: a.until === null }),
      })
      .execute();
    return true;
  });
}
