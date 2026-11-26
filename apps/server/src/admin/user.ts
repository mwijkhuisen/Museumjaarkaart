import { Handle, ROLES } from '@mjk/contracts';
import { AdminError, EXIT_NOT_FOUND, EXIT_USAGE } from '../museums/curation.ts';
import type { Command } from './cli.ts';

/** `admin user role <handle> <role>`: the only way a member becomes a moderator or admin. */
export const userRole: Command['run'] = async (ctx) => {
  const [rawHandle, role] = ctx.pos as [string, string];
  const handle = Handle.safeParse(rawHandle);
  if (!handle.success || !(ROLES as readonly string[]).includes(role)) throw new AdminError(EXIT_USAGE, 'usage');
  await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('app_user')
      .set({ role })
      .where('handle', '=', handle.data)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) throw new AdminError(EXIT_NOT_FOUND, 'user_not_found');
    await trx
      .insertInto('audit_log')
      .values({
        actor_kind: 'admin',
        actor_id: null,
        action: 'user.role',
        target_kind: 'user',
        target_id: row.id,
        detail: JSON.stringify({ role }),
      })
      .execute();
  });
  ctx.io.out(`user ${handle.data} role ${role}`);
  return 0;
};
