import type { PassportDb } from '../passport/fixtures.ts';

// P3a's review fixture: a review inserted as mjk_api (the login that writes them), through the raw pool with
// production's type parsers. Rows that no login may write freely (a state, a detach) are the owner's:
// p.owner.

export type ReviewInput = {
  userId: string;
  museumId: string;
  visitId: string;
  rating: number;
  collection?: number | null;
  presentation?: number | null;
  kid_friendly?: number | null;
  accessibility?: number | null;
  facilities?: number | null;
  value_for_money?: number | null;
  body?: string | null;
};

/** Inserts one review as mjk_api and returns its id. */
export async function addReview(p: PassportDb, r: ReviewInput): Promise<string> {
  const res = await p.pools.api.query<{ id: string }>(
    `INSERT INTO review (user_id, museum_id, visit_id, rating, collection, presentation, kid_friendly,
       accessibility, facilities, value_for_money, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      r.userId,
      r.museumId,
      r.visitId,
      r.rating,
      r.collection ?? null,
      r.presentation ?? null,
      r.kid_friendly ?? null,
      r.accessibility ?? null,
      r.facilities ?? null,
      r.value_for_money ?? null,
      r.body ?? null,
    ],
  );
  return (res.rows[0] as { id: string }).id;
}

/** A member with a visit to a museum, and (when rating is given) a review citing it. */
export async function memberWithReview(
  p: PassportDb,
  museumId: string,
  opts: Partial<{ status: string; rating: number; body: string | null; on: string | null }> = {},
): Promise<{ userId: string; handle: string; visitId: string; reviewId: string }> {
  const u = await p.newMember(opts.status === undefined ? {} : { status: opts.status });
  const visitId = await p.addVisit(u.id, museumId, opts.on === undefined ? {} : { on: opts.on });
  const reviewId = await addReview(p, {
    userId: u.id,
    museumId,
    visitId,
    rating: opts.rating ?? 4,
    body: opts.body === undefined ? 'Mooi.' : opts.body,
  });
  return { userId: u.id, handle: u.handle, visitId, reviewId };
}
