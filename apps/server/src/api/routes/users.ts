import {
  EmptyQuery,
  HANDLE_RE,
  PhotoList,
  PhotoListQuery,
  PublicListQuery,
  PublicVisitList,
  PublicWishlist,
  ReviewList,
  ReviewListQuery,
  UserProfile,
} from '@mjk/contracts';
import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../../db/kysely.ts';
import { InvalidPhotoCursor, photosOfUser } from '../../media/public.ts';
import { decodeCursor, encodeCursor } from '../../museums/cursor.ts';
import { publicProgress } from '../../passport/progress.ts';
import { InvalidReviewCursor, reviewsOfUser } from '../../reviews/public.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The public profile (A§10, P2c): GET /users/:handle, /users/:handle/visits and /users/:handle/wishlist.
// No session is read (the paths are outside the session middleware's) and every query reads only `pub_profile`,
// `pub_visit_log(handle)`, `pub_wishlist_of(handle)`, `pub_museum` and the list views, so the routes run as
// `mjk_ssr` on the ssr role's in-process app too. A handle that fails HANDLE_RE cannot exist: 404 before any SQL.
// A private list, an unknown member and an inactive one all answer the same 404 (A§10).
// The keyset cursor is the catalogue's name cursor `{m:'n', k, i}`: the wishlist's k is the museum's sort_name,
// the visit log's k is the month ('' for an undated visit, which sorts last).

/** The profile's inline first page of each list. */
const PROFILE_PAGE = 20;

type Profile = {
  display_name: string;
  member_since: string;
  indexable: boolean;
  visits_public: boolean;
  wishlist_public: boolean;
};

type Museum = { slug: string; name: string; name_en: string | null; place: string | null };

const museumOf = (r: Museum): Museum => ({ slug: r.slug, name: r.name, name_en: r.name_en, place: r.place });

async function findProfile(db: Db, handle: string): Promise<Profile | undefined> {
  const { rows } = await sql<Profile>`
    SELECT display_name, member_since, indexable, visits_public, wishlist_public
      FROM pub_profile WHERE handle = ${handle}`.execute(db);
  return rows[0];
}

/** The decoded cursor, or a 400: a malformed one, a search cursor, or (for visits) a key that is not a month. */
function cursorOf(raw: string | undefined, kind: 'month' | 'name'): { k: string; i: string } | null {
  if (raw === undefined) return null;
  const d = decodeCursor(raw);
  if (!d.ok || d.cursor.m !== 'n' || (kind === 'month' && !/^(\d{4}-\d{2})?$/.test(d.cursor.k)))
    throw new ApiError('bad_request', ['cursor']);
  return d.cursor;
}

type Page = { limit: number; cursor?: string | undefined };

async function visitPage(db: Db, handle: string, p: Page): Promise<PublicVisitList> {
  const cur = cursorOf(p.cursor, 'month');
  // (month DESC NULLS LAST, museum_id): the undated visits come after every month.
  let after: RawBuilder<unknown> = sql`TRUE`;
  if (cur !== null)
    after =
      cur.k === ''
        ? sql`(l.visited_month IS NULL AND l.museum_id > ${cur.i}::uuid)`
        : sql`(l.visited_month < ${cur.k}::text
               OR (l.visited_month = ${cur.k}::text AND l.museum_id > ${cur.i}::uuid)
               OR l.visited_month IS NULL)`;
  const { rows } = await sql<Museum & { museum_id: string; visited_month: string | null; visits: number }>`
    SELECT l.museum_id, l.visited_month, l.visits::int AS visits, m.slug, m.name, m.name_en, m.place
      FROM pub_visit_log(${handle}) l
      JOIN pub_museum m ON m.id = l.museum_id
     WHERE ${after}
     ORDER BY l.visited_month DESC NULLS LAST, l.museum_id
     LIMIT ${p.limit + 1}`.execute(db);
  const page = rows.slice(0, p.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ museum: museumOf(r), visited_month: r.visited_month, visits: r.visits })),
    next:
      rows.length > p.limit && last !== undefined
        ? encodeCursor({ m: 'n', k: last.visited_month ?? '', i: last.museum_id })
        : null,
  };
}

async function wishlistPage(db: Db, handle: string, p: Page): Promise<PublicWishlist> {
  const cur = cursorOf(p.cursor, 'name');
  const after = cur === null ? sql`TRUE` : sql`(m.sort_name, m.id) > (${cur.k}::text, ${cur.i}::uuid)`;
  const { rows } = await sql<Museum & { id: string; sort_name: string }>`
    SELECT m.id, m.sort_name, m.slug, m.name, m.name_en, m.place
      FROM pub_wishlist_of(${handle}) w
      JOIN pub_museum m ON m.id = w.museum_id
     WHERE ${after}
     ORDER BY m.sort_name, m.id
     LIMIT ${p.limit + 1}`.execute(db);
  const page = rows.slice(0, p.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ museum: museumOf(r) })),
    next: rows.length > p.limit && last !== undefined ? encodeCursor({ m: 'n', k: last.sort_name, i: last.id }) : null,
  };
}

const handleOf = (raw: string | undefined): string => {
  if (raw === undefined || !HANDLE_RE.test(raw)) throw new ApiError('not_found');
  return raw;
};

export function mountUsers(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;

  v1.get('/users/:handle', async (c) => {
    const handle = handleOf(c.req.param('handle'));
    parseQuery(c, EmptyQuery);
    const p = await findProfile(db, handle);
    if (p === undefined) throw new ApiError('not_found');
    const first = { limit: PROFILE_PAGE, cursor: undefined };
    return sendJson(
      c,
      UserProfile,
      {
        handle,
        display_name: p.display_name,
        member_since: p.member_since,
        indexable: p.indexable,
        progress: p.visits_public ? await publicProgress(db, handle) : null,
        visits: p.visits_public ? await visitPage(db, handle, first) : null,
        wishlist: p.wishlist_public ? await wishlistPage(db, handle, first) : null,
      },
      CACHE_PUBLIC,
    );
  });

  v1.get('/users/:handle/visits', async (c) => {
    const handle = handleOf(c.req.param('handle'));
    const q = parseQuery(c, PublicListQuery);
    if (!(await findProfile(db, handle))?.visits_public) throw new ApiError('not_found');
    return sendJson(c, PublicVisitList, await visitPage(db, handle, q), CACHE_PUBLIC);
  });

  v1.get('/users/:handle/wishlist', async (c) => {
    const handle = handleOf(c.req.param('handle'));
    const q = parseQuery(c, PublicListQuery);
    if (!(await findProfile(db, handle))?.wishlist_public) throw new ApiError('not_found');
    return sendJson(c, PublicWishlist, await wishlistPage(db, handle, q), CACHE_PUBLIC);
  });

  // P3a: the member's visible reviews, newest first (an active member only; no setting hides them, D17).
  v1.get('/users/:handle/reviews', async (c) => {
    const handle = handleOf(c.req.param('handle'));
    const q = parseQuery(c, ReviewListQuery);
    if ((await findProfile(db, handle)) === undefined) throw new ApiError('not_found');
    try {
      return sendJson(c, ReviewList, await reviewsOfUser(db, handle, q), CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidReviewCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });
  // P3b: the member's published photos, newest first (pub_media only; an active member, like the reviews).
  v1.get('/users/:handle/photos', async (c) => {
    const handle = handleOf(c.req.param('handle'));
    const q = parseQuery(c, PhotoListQuery);
    if ((await findProfile(db, handle)) === undefined) throw new ApiError('not_found');
    try {
      return sendJson(c, PhotoList, await photosOfUser(db, handle, q), CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidPhotoCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });
}
