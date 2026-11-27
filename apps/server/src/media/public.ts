import type { GalleryPhoto, OwnPhoto, PhotoList, PublicPhoto } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { decodeCursor, encodeCursor } from '../museums/cursor.ts';

// The reads of photos (A§8, A§14, P3b WP5). Everything public comes from `pub_media` alone: approved photos of a
// visible review of a visible museum by an author who is not deleted. A pending, rejected, failed or removed
// photo is not in it, so no query here can show one; the member's own view reads `media` as mjk_api, keyed on
// the member's id. Neither ever selects a user id, a hash, a state of someone else's or a file path.

type PublicRow = {
  id: string;
  review_id: string;
  width: number;
  height: number;
  alt_text: string | null;
  public_key: string;
  widths: number[];
};

const toPhoto = (r: PublicRow): PublicPhoto => ({
  id: r.id,
  width: r.width,
  height: r.height,
  alt_text: r.alt_text,
  public_key: r.public_key,
  widths: r.widths,
});

/** The published photos of these reviews, by review id, oldest first (one query for a page of reviews). */
export async function photosOfReviews(db: Db, reviewIds: readonly string[]): Promise<Map<string, PublicPhoto[]>> {
  const by = new Map<string, PublicPhoto[]>();
  if (reviewIds.length === 0) return by;
  const { rows } = await sql<PublicRow>`SELECT id, review_id, width, height, alt_text, public_key, widths
      FROM pub_media WHERE review_id = ANY(${reviewIds as string[]}::uuid[]) ORDER BY id`.execute(db);
  for (const r of rows) by.set(r.review_id, [...(by.get(r.review_id) ?? []), toPhoto(r)]);
  return by;
}

type OwnRow = {
  id: string;
  review_id: string | null;
  state: OwnPhoto['state'];
  width: number | null;
  height: number | null;
  alt_text: string | null;
  public_key: string | null;
  widths: number[];
};

/**
 * The member's own photos matching `where`, any state but failed and removed, oldest first. The public key and
 * the widths show only once approved: before that no object exists on R2 and the preview route is the way to look.
 */
async function ownRows(db: Db, userId: string, where: ReturnType<typeof sql>): Promise<OwnRow[]> {
  const { rows } = await sql<OwnRow>`SELECT md.id, md.review_id, md.state, md.width, md.height, md.alt_text,
      CASE WHEN md.state = 'approved' THEN md.public_key END AS public_key,
      CASE WHEN md.state = 'approved'
        THEN ARRAY(SELECT v.width FROM media_variant v WHERE v.media_id = md.id AND v.format = 'avif' ORDER BY v.width)
        ELSE ARRAY[]::integer[] END AS widths
      FROM media md
     WHERE md.user_id = ${userId}::uuid AND md.state NOT IN ('failed', 'removed') AND ${where}
     ORDER BY md.id`.execute(db);
  return rows;
}

const toOwnPhoto = ({ review_id: _review, ...photo }: OwnRow): OwnPhoto => photo;

/** The member's own photos of these reviews, by review id (one query for a page of reviews). */
export async function ownPhotosOfReviews(
  db: Db,
  userId: string,
  reviewIds: readonly string[],
): Promise<Map<string, OwnPhoto[]>> {
  const by = new Map<string, OwnPhoto[]>();
  if (reviewIds.length === 0) return by;
  for (const r of await ownRows(db, userId, sql`md.review_id = ANY(${reviewIds as string[]}::uuid[])`)) {
    const key = r.review_id as string;
    by.set(key, [...(by.get(key) ?? []), toOwnPhoto(r)]);
  }
  return by;
}

/** One of the member's own photos, or undefined (another member's, failed, removed and unknown are one). */
export async function ownPhoto(db: Db, userId: string, id: string): Promise<OwnPhoto | undefined> {
  const r = (await ownRows(db, userId, sql`md.id = ${id}::uuid`))[0];
  return r === undefined ? undefined : toOwnPhoto(r);
}

/** A cursor that is malformed or not an id-mode cursor. */
export class InvalidPhotoCursor extends Error {
  constructor() {
    super('invalid_photo_cursor');
  }
}

type GalleryRow = PublicRow & {
  author_handle: string | null;
  museum_id: string;
  museum_slug: string;
  museum_name: string;
  museum_name_en: string | null;
};

const toGallery = (r: GalleryRow): GalleryPhoto => ({
  ...toPhoto(r),
  review_id: r.review_id,
  author_handle: r.author_handle,
  museum: { id: r.museum_id, slug: r.museum_slug, name: r.museum_name, name_en: r.museum_name_en },
});

function beforeOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const d = decodeCursor(raw);
  if (!d.ok || d.cursor.m !== 'i') throw new InvalidPhotoCursor();
  return d.cursor.i;
}

type Page = { limit: number; cursor?: string | undefined };

async function page(db: Db, where: ReturnType<typeof sql>, p: Page): Promise<PhotoList> {
  const before = beforeOf(p.cursor);
  const after = before === null ? sql`TRUE` : sql`md.id < ${before}::uuid`;
  const { rows } = await sql<GalleryRow>`SELECT md.id, md.review_id, md.width, md.height, md.alt_text, md.public_key,
      md.widths, md.author_handle, m.id AS museum_id, m.slug AS museum_slug, m.name AS museum_name,
      m.name_en AS museum_name_en
      FROM pub_media md JOIN pub_museum m ON m.id = md.museum_id
     WHERE ${where} AND ${after}
     ORDER BY md.id DESC LIMIT ${p.limit + 1}`.execute(db);
  const items = rows.slice(0, p.limit);
  const last = items.at(-1);
  return {
    items: items.map(toGallery),
    next_cursor: rows.length > p.limit && last !== undefined ? encodeCursor({ m: 'i', i: last.id }) : null,
  };
}

/** One page of a museum's published photos, newest first. The caller has checked that the museum is visible. */
export const photosOfMuseum = (db: Db, museumId: string, p: Page): Promise<PhotoList> =>
  page(db, sql`md.museum_id = ${museumId}::uuid`, p);

/** One page of an active member's published photos, newest first. The caller has checked the handle (HANDLE_RE). */
export const photosOfUser = (db: Db, handle: string, p: Page): Promise<PhotoList> =>
  page(db, sql`md.author_handle = ${handle}`, p);
