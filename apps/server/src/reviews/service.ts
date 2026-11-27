import { ASPECTS, type Aspect, type OwnReview, type ReviewCreate, type ReviewPatch } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { NL_TODAY } from '../museums/near.ts';

// The review writes (A§8, A§14, P3a). Every query is keyed on the member's id (the session's), so another
// member's review is "not found", never "forbidden". Callers own the rate limit, the `content_ip_log` row and
// the stats queue; none is written here (the CSV import calls createReview too).

/** A review as it is written: the rating, the optional aspects and the normalised body (null when empty). */
export type ReviewWrite = Omit<ReviewCreate, 'body'> & { body: string | null };

/** Why a create was refused; the route maps each to its answer, the import to a row error. */
export type CreateRefusal = 'museum_unknown' | 'museum_closed' | 'visit_not_own' | 'review_exists';

export type CreateResult = { ok: true; id: string } | { ok: false; reason: CreateRefusal };

/**
 * The one create path (POST /reviews and the import's confirm), on the caller's transaction. It checks that the
 * museum is known, not hidden and not closed, that the visit is the member's own visit to that museum (the row is
 * locked FOR KEY SHARE, so a concurrent visit delete cannot slip between this check and the insert's foreign
 * key) and that the member has no review of it yet, then inserts.
 */
export async function createReview(trx: Db, userId: string, input: ReviewWrite): Promise<CreateResult> {
  const museum = await sql<{ closed: boolean }>`SELECT (closed_on IS NOT NULL AND closed_on <= ${NL_TODAY}) AS closed
      FROM museum WHERE id = ${input.museum_id}::uuid AND NOT hidden`.execute(trx);
  const m = museum.rows[0];
  if (m === undefined) return { ok: false, reason: 'museum_unknown' };
  if (m.closed) return { ok: false, reason: 'museum_closed' };
  if ((await lockOwnVisit(trx, userId, input.visit_id, input.museum_id)) === undefined)
    return { ok: false, reason: 'visit_not_own' };
  const aspect = (a: Aspect) => input[a] ?? null;
  // No conflict target: review_once (user, museum) is the only unique key besides the generated id.
  const { rows } = await sql<{ id: string }>`INSERT INTO review (user_id, museum_id, visit_id, rating,
      collection, presentation, kid_friendly, accessibility, facilities, value_for_money, body)
    VALUES (${userId}::uuid, ${input.museum_id}::uuid, ${input.visit_id}::uuid, ${input.rating},
      ${aspect('collection')}, ${aspect('presentation')}, ${aspect('kid_friendly')}, ${aspect('accessibility')},
      ${aspect('facilities')}, ${aspect('value_for_money')}, ${input.body})
    ON CONFLICT DO NOTHING RETURNING id`.execute(trx);
  const id = rows[0]?.id;
  return id === undefined ? { ok: false, reason: 'review_exists' } : { ok: true, id };
}

/** Locks the member's own visit to the museum FOR KEY SHARE; its date as text (null undated), undefined when none. */
async function lockOwnVisit(
  trx: Db,
  userId: string,
  visitId: string,
  museumId: string,
): Promise<{ cited_on: string | null } | undefined> {
  const r = await sql<{ cited_on: string | null }>`SELECT visited_on::text AS cited_on FROM visit
    WHERE id = ${visitId}::uuid AND user_id = ${userId}::uuid AND museum_id = ${museumId}::uuid
    FOR KEY SHARE`.execute(trx);
  return r.rows[0];
}

type OwnRow = {
  id: string;
  museum_id: string;
  visit_id: string;
  visited_on: string | null;
  rating: number;
  collection: number | null;
  presentation: number | null;
  kid_friendly: number | null;
  accessibility: number | null;
  facilities: number | null;
  value_for_money: number | null;
  body: string | null;
  created_at: Date;
  edited_at: Date | null;
};

const toOwn = (r: OwnRow): OwnReview => ({
  ...r,
  created_at: r.created_at.toISOString(),
  edited_at: r.edited_at === null ? null : r.edited_at.toISOString(),
});

const OWN_COLUMNS = sql`r.id, r.museum_id, r.visit_id, v.visited_on, r.rating, r.collection, r.presentation,
  r.kid_friendly, r.accessibility, r.facilities, r.value_for_money, r.body, r.created_at, r.edited_at`;

/** The member's own visible review by id, or undefined. */
export async function ownReview(db: Db, userId: string, id: string): Promise<OwnReview | undefined> {
  const { rows } = await sql<OwnRow>`SELECT ${OWN_COLUMNS} FROM review r JOIN visit v ON v.id = r.visit_id
    WHERE r.id = ${id}::uuid AND r.user_id = ${userId}::uuid AND r.state = 'visible'`.execute(db);
  return rows[0] === undefined ? undefined : toOwn(rows[0]);
}

/** The member's own visible review of a museum, or null. */
export async function ownReviewOfMuseum(db: Db, userId: string, museumId: string): Promise<OwnReview | null> {
  const { rows } = await sql<OwnRow>`SELECT ${OWN_COLUMNS} FROM review r JOIN visit v ON v.id = r.visit_id
    WHERE r.museum_id = ${museumId}::uuid AND r.user_id = ${userId}::uuid AND r.state = 'visible'`.execute(db);
  return rows[0] === undefined ? null : toOwn(rows[0]);
}

export type EditResult = { ok: true } | { ok: false; reason: 'not_found' | 'museum_closed' | 'visit_not_own' };

type Current = { museum_id: string; rating: number; body: string | null } & { [A in Aspect]: number | null };

/**
 * Edits the member's own visible review on the caller's transaction. Another member's review, a removed one, an
 * unknown id and a hidden museum are all `not_found`. A change of the rating, an aspect or the body keeps the old
 * values in one `review_revision` row (insert only: mjk_api cannot read it back) and sets `edited_at`. A change
 * of the cited visit writes no revision; it sets `edited_at` only when the new visit's date differs (the date a
 * review shows is part of its content, A§11).
 */
export async function editReview(trx: Db, userId: string, id: string, patch: ReviewPatch): Promise<EditResult> {
  const found = await sql<Current & { hidden: boolean; closed: boolean; cited_on: string | null }>`SELECT r.museum_id,
      r.rating, r.collection, r.presentation, r.kid_friendly, r.accessibility, r.facilities, r.value_for_money,
      r.body, m.hidden, (m.closed_on IS NOT NULL AND m.closed_on <= ${NL_TODAY}) AS closed, v.visited_on::text AS cited_on
    FROM review r JOIN museum m ON m.id = r.museum_id LEFT JOIN visit v ON v.id = r.visit_id
    WHERE r.id = ${id}::uuid AND r.user_id = ${userId}::uuid AND r.state = 'visible'
    FOR UPDATE OF r`.execute(trx);
  const cur = found.rows[0];
  if (cur === undefined || cur.hidden) return { ok: false, reason: 'not_found' };
  if (cur.closed) return { ok: false, reason: 'museum_closed' };
  const next =
    patch.visit_id === undefined ? undefined : await lockOwnVisit(trx, userId, patch.visit_id, cur.museum_id);
  if (patch.visit_id !== undefined && next === undefined) return { ok: false, reason: 'visit_not_own' };
  const dateMoved = next !== undefined && next.cited_on !== cur.cited_on;

  const content: { rating?: number; body?: string | null } & { [A in Aspect]?: number | null } = {};
  if (patch.rating !== undefined && patch.rating !== cur.rating) content.rating = patch.rating;
  if (patch.body !== undefined && patch.body !== cur.body) content.body = patch.body;
  for (const a of ASPECTS) {
    const next = patch[a];
    if (next !== undefined && next !== cur[a]) content[a] = next;
  }
  const changed = Object.keys(content).length > 0;
  if (changed) {
    await trx
      .insertInto('review_revision')
      .values({
        review_id: id,
        rating: cur.rating,
        body: cur.body,
        ...Object.fromEntries(ASPECTS.map((a) => [a, cur[a]])),
      })
      .execute();
  }
  if (changed || patch.visit_id !== undefined) {
    await trx
      .updateTable('review')
      .set({
        ...content,
        ...(patch.visit_id === undefined ? {} : { visit_id: patch.visit_id }),
        ...(changed || dateMoved ? { edited_at: sql<Date>`now()` } : {}),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }
  return { ok: true };
}

/** Deletes the member's own visible review; false when there is none (another member's, removed, unknown). */
export async function deleteReview(trx: Db, userId: string, id: string): Promise<boolean> {
  const gone = await trx
    .deleteFrom('review')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('state', '=', 'visible')
    .returning('id')
    .executeTakeFirst();
  return gone !== undefined;
}
