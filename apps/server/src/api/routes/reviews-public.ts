import {
  EmptyQuery,
  PhotoList,
  PhotoListQuery,
  PublicReview,
  ReviewIdParam,
  ReviewList,
  ReviewListQuery,
  SlugParam,
} from '@mjk/contracts';
import type { Context } from 'hono';
import { sql } from 'kysely';
import { InvalidPhotoCursor, photosOfMuseum } from '../../media/public.ts';
import { findRedirect } from '../../museums/detail.ts';
import { InvalidReviewCursor, reviewById, reviewsOfMuseum } from '../../reviews/public.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC, CACHE_REDIRECT } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The public review reads (A§14, P3a): one review and a museum's reviews, newest first, and (P3b) a museum's
// published photos. The user's list is in
// users.ts, next to the rest of the profile. No session is read (the paths are outside the session
// middleware's for a GET) and every query is one of the `pub_review*` functions, so the routes also run as
// `mjk_ssr` on the ssr role's in-process app. A malformed id is a 404 before SQL (the 22P02 gotcha).

export function mountReviewsPublic(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;

  v1.get('/reviews/:id', async (c) => {
    const id = ReviewIdParam.safeParse(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    if (!id.success) throw new ApiError('not_found');
    const review = await reviewById(db, id.data);
    if (review === undefined) throw new ApiError('not_found');
    return sendJson(c, PublicReview, review, CACHE_PUBLIC);
  });

  /** The visible museum's id, or the 301 to its current slug, or a 404 (hidden and unknown are one). */
  async function museumOr301(c: Context<ApiEnv>, slug: string, then: string): Promise<string | Response> {
    const found = await sql<{ id: string }>`SELECT id FROM pub_museum WHERE slug = ${slug}`.execute(db);
    const museumId = found.rows[0]?.id;
    if (museumId !== undefined) return museumId;
    const current = await findRedirect(db, slug);
    if (current === null) throw new ApiError('not_found');
    c.header('Cache-Control', CACHE_REDIRECT);
    c.header('Location', `/api/v1/museums/${current}/${then}`);
    return c.body(null, 301);
  }

  v1.get('/museums/:slug/reviews', async (c) => {
    const slug = parseParam('slug', c.req.param('slug'), SlugParam);
    const q = parseQuery(c, ReviewListQuery);
    const museumId = await museumOr301(c, slug, 'reviews');
    if (typeof museumId !== 'string') return museumId;
    try {
      return sendJson(c, ReviewList, await reviewsOfMuseum(db, museumId, q), CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidReviewCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });

  // P3b: the published photos of a museum, newest first (pub_media only: approved, on a visible review).
  v1.get('/museums/:slug/photos', async (c) => {
    const slug = parseParam('slug', c.req.param('slug'), SlugParam);
    const q = parseQuery(c, PhotoListQuery);
    const museumId = await museumOr301(c, slug, 'photos');
    if (typeof museumId !== 'string') return museumId;
    try {
      return sendJson(c, PhotoList, await photosOfMuseum(db, museumId, q), CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidPhotoCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });
}
