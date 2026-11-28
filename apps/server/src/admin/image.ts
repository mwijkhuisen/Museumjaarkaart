import { COMMONS_IMAGE_JOB } from '../museums/commons/store.ts';
import { AdminError, EXIT_DATA, EXIT_NOT_FOUND, EXIT_USAGE, findMuseum } from '../museums/curation.ts';
import { enqueueIn } from '../worker/queue.ts';
import { type Command, clean } from './cli.ts';

/**
 * `admin museum image hide|unhide <museum>` (ADR-0018): as mjk_api, which holds no R2 key. `hide` drops the image from
 * `pub_museum_image` at once and queues `commons_image`, whose worker deletes the objects; `unhide` makes the row
 * `skipped`, and the same job fetches the file again. One audit row of codes (never a file name or a credit).
 */
export const museumImage: Command['run'] = async (ctx) => {
  const [action, ref] = ctx.pos as [string, string];
  if (action !== 'hide' && action !== 'unhide') throw new AdminError(EXIT_USAGE, 'usage');
  const hide = action === 'hide';
  const m = await ctx.db.transaction().execute(async (trx) => {
    const m = await findMuseum(trx, ref);
    const row = await trx
      .selectFrom('museum_image')
      .select(['state', 'skip_code'])
      .where('museum_id', '=', m.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new AdminError(EXIT_NOT_FOUND, 'image_not_found');
    if (hide ? row.state === 'hidden' : row.state !== 'hidden') return { ...m, changed: false };
    // A skipped row needs its code: the worker gives a hidden row one when it removes the objects.
    if (!hide && row.skip_code === null) throw new AdminError(EXIT_DATA, 'hide_not_processed_yet');
    await trx
      .updateTable('museum_image')
      .set({ state: hide ? 'hidden' : 'skipped' })
      .where('museum_id', '=', m.id)
      .execute();
    await enqueueIn(trx, COMMONS_IMAGE_JOB, { museum_id: m.id }, {});
    await trx
      .insertInto('audit_log')
      .values({
        actor_kind: 'admin',
        actor_id: null,
        action: hide ? 'museum.image_hide' : 'museum.image_unhide',
        target_kind: 'museum',
        target_id: m.id,
        detail: JSON.stringify({}),
      })
      .execute();
    return { ...m, changed: true };
  });
  ctx.io.out(`${m.slug} (${clean(m.name)}): image ${m.changed ? (hide ? 'hidden' : 'unhidden') : 'no change'}`);
  return 0;
};
