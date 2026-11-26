import { Email, LOCALES } from '@mjk/contracts';
import { createInvite } from '../auth/invite.ts';
import { enqueueMailInvite } from '../mail/payloads.ts';
import { AdminError, EXIT_USAGE } from '../museums/curation.ts';
import type { Ctx } from './cli.ts';

// `admin invite create` (A§9): until P3d invites go only to the owner and test accounts. The code is
// printed once; the address, the code and the note never reach the audit row or the output's second line.

const intIn = (v: string | undefined, def: number, min: number, max: number): number => {
  if (v === undefined) return def;
  const n = /^[0-9]{1,5}$/.test(v) ? Number(v) : 0;
  if (n < min || n > max) throw new AdminError(EXIT_USAGE, 'usage');
  return n;
};

export async function inviteCreate(ctx: Ctx, flag: (name: string) => string | undefined): Promise<number> {
  const maxUses = intIn(flag('uses'), 1, 1, 1000);
  const days = intIn(flag('days'), 14, 1, 365);
  const locale = flag('locale') ?? 'nl';
  if (!(LOCALES as readonly string[]).includes(locale)) throw new AdminError(EXIT_USAGE, 'usage');
  const rawEmail = flag('email');
  const email = rawEmail === undefined ? undefined : Email.safeParse(rawEmail);
  if (email !== undefined && !email.success) throw new AdminError(EXIT_USAGE, 'usage');
  const note = flag('note');
  // A§8: the note holds no personal data, so nothing that looks like an address.
  if (note !== undefined && (note.length > 200 || /[\p{Cc}\p{Cf}\u{2028}\u{2029}@]/u.test(note))) {
    throw new AdminError(EXIT_USAGE, 'usage');
  }
  const keys = ctx.keys;
  if (keys === undefined) throw new AdminError(EXIT_USAGE, 'usage');
  const to = email?.data;

  const inv = await ctx.db.transaction().execute(async (trx) => {
    const i = await createInvite(trx, keys, { maxUses, days, note: note ?? null });
    if (to !== undefined) {
      await enqueueMailInvite(trx, keys, { inviteId: i.id, code: i.code, to, locale: locale as 'nl' | 'en' });
    }
    await trx
      .insertInto('audit_log')
      .values({
        actor_kind: 'admin',
        actor_id: null,
        action: 'invite.create',
        target_kind: 'invite',
        target_id: i.id,
        detail: JSON.stringify({ max_uses: maxUses, days, mailed: to !== undefined }),
      })
      .execute();
    return i;
  });
  ctx.io.out(
    `invite ${inv.code} valid until ${inv.expiresAt.toISOString().slice(0, 10)} (${maxUses} ${maxUses === 1 ? 'use' : 'uses'})`,
  );
  if (to !== undefined) ctx.io.out('mail job queued');
  return 0;
}
