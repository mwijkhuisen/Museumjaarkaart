import type { PublicPhoto, PublicReview, ReviewList } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { photosOfReviews } from '../media/public.ts';
import { decodeCursor, encodeCursor } from '../museums/cursor.ts';

// The public reads of reviews (A§8, A§14, P3a): only the three `pub_review*` functions, which return visible
// reviews of non-hidden museums, no author who is deleted, and never a user id, a visit id, a note, a revision
// or a state. They run as mjk_api and as mjk_ssr (the ssr's in-process app).

/** A cursor that is malformed or not an id-mode cursor. */
export class InvalidReviewCursor extends Error {
  constructor() {
    super('invalid_review_cursor');
  }
}

type Row = {
  id: string;
  museum_id: string;
  museum_slug: string;
  museum_name: string;
  museum_name_en: string | null;
  author_handle: string | null;
  author_display_name: string | null;
  author_active: boolean;
  former_member: boolean;
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

const toPublic = (r: Row, photos: PublicPhoto[] | undefined): PublicReview => ({
  id: r.id,
  museum: { id: r.museum_id, slug: r.museum_slug, name: r.museum_name, name_en: r.museum_name_en },
  author: {
    handle: r.author_handle,
    display_name: r.author_display_name,
    active: r.author_active,
    former_member: r.former_member,
  },
  visited_on: r.visited_on,
  rating: r.rating,
  collection: r.collection,
  presentation: r.presentation,
  kid_friendly: r.kid_friendly,
  accessibility: r.accessibility,
  facilities: r.facilities,
  value_for_money: r.value_for_money,
  body: r.body,
  created_at: r.created_at.toISOString(),
  edited_at: r.edited_at === null ? null : r.edited_at.toISOString(),
  photos: photos ?? [],
});

/** The review with this id, or undefined (removed, hidden museum, deleted author and unknown are all one). */
export async function reviewById(db: Db, id: string): Promise<PublicReview | undefined> {
  const { rows } = await sql<Row>`SELECT * FROM pub_review(${id}::uuid)`.execute(db);
  const row = rows[0];
  if (row === undefined) return undefined;
  return toPublic(row, (await photosOfReviews(db, [row.id])).get(row.id));
}

function beforeOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const d = decodeCursor(raw);
  if (!d.ok || d.cursor.m !== 'i') throw new InvalidReviewCursor();
  return d.cursor.i;
}

async function pageOf(db: Db, rows: Row[], limit: number): Promise<ReviewList> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  // The published photos of the whole page in one query, from pub_media only.
  const photos = await photosOfReviews(
    db,
    page.map((r) => r.id),
  );
  return {
    items: page.map((r) => toPublic(r, photos.get(r.id))),
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ m: 'i', i: last.id }) : null,
  };
}

type Page = { limit: number; cursor?: string | undefined };

/** One page of a museum's reviews, newest first. The caller has checked that the museum is visible. */
export async function reviewsOfMuseum(db: Db, museumId: string, p: Page): Promise<ReviewList> {
  const before = beforeOf(p.cursor);
  const { rows } =
    await sql<Row>`SELECT * FROM pub_reviews_of_museum(${museumId}::uuid, ${before}::uuid, ${p.limit + 1})`.execute(db);
  return pageOf(db, rows, p.limit);
}

/** One page of an active member's reviews, newest first. The caller has checked the handle (HANDLE_RE). */
export async function reviewsOfUser(db: Db, handle: string, p: Page): Promise<ReviewList> {
  const before = beforeOf(p.cursor);
  const { rows } =
    await sql<Row>`SELECT * FROM pub_reviews_of_user(${handle}, ${before}::uuid, ${p.limit + 1})`.execute(db);
  return pageOf(db, rows, p.limit);
}
