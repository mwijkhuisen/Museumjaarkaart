import { SLUG_MAX, SLUG_RE } from '@mjk/contracts';
import type { Db } from '../db/kysely.ts';
import { AdminError, EXIT_DATA, findMuseum } from './curation.ts';
import { uniqueSlug } from './slug.ts';

// The owner's slug change (owner decision Q1): a slug changes only through `admin museum slug`;
// applying a name change keeps it. The museum_slug_keep trigger writes the redirect from the old
// slug; museum_slug_guard refuses a slug that another museum once had.

export type SlugChange = { old: string; new: string; changed: boolean };

/** `target` is an explicit slug, or `{ fromName: true }` to derive one from the museum's name and place. */
export async function changeSlug(db: Db, ref: string, target: string | { fromName: true }): Promise<SlugChange> {
  if (typeof target === 'string' && (target.length > SLUG_MAX || !SLUG_RE.test(target))) {
    throw new AdminError(EXIT_DATA, 'bad_slug');
  }
  return db.transaction().execute(async (trx) => {
    const m = await findMuseum(trx, ref); // locks the museum row
    // Other museums' current slugs and every old slug that is not this museum's own.
    const takenRows = await trx.selectFrom('museum').select('slug').where('id', '<>', m.id).execute();
    const oldRows = await trx
      .selectFrom('museum_slug_redirect')
      .select('old_slug')
      .where('museum_id', '<>', m.id)
      .execute();
    const taken = new Set([...takenRows.map((r) => r.slug), ...oldRows.map((r) => r.old_slug)]);
    let slug: string;
    if (typeof target === 'string') {
      slug = target;
    } else {
      const own = await trx.selectFrom('museum').select('place').where('id', '=', m.id).executeTakeFirstOrThrow();
      slug = uniqueSlug(m.name, own.place, taken);
      if (slug.length > SLUG_MAX || !SLUG_RE.test(slug)) throw new AdminError(EXIT_DATA, 'bad_slug');
    }
    if (taken.has(slug)) throw new AdminError(EXIT_DATA, 'slug_taken');
    if (slug === m.slug) return { old: m.slug, new: slug, changed: false };
    try {
      await trx.updateTable('museum').set({ slug }).where('id', '=', m.id).execute();
    } catch (err) {
      if ((err as { code?: unknown }).code === '23505') throw new AdminError(EXIT_DATA, 'slug_taken');
      throw err;
    }
    return { old: m.slug, new: slug, changed: true };
  });
}
