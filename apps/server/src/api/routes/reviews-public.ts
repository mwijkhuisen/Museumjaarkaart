import { EmptyQuery, PublicReview, ReviewIdParam, ReviewList, ReviewListQuery, SlugParam } from '@mjk/contracts';
import { sql } from 'kysely';
import { findRedirect } from '../../museums/detail.ts';
import { InvalidReviewCursor, reviewById, reviewsOfMuseum } from '../../reviews/public.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC, CACHE_REDIRECT } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The public review reads (A§14, P3a): one review and a museum's reviews, newest first. The user's list is in
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

  v1.get('/museums/:slug/reviews', async (c) => {
    const slug = parseParam('slug', c.req.param('slug'), SlugParam);
    const q = parseQuery(c, ReviewListQuery);
    const found = await sql<{ id: string }>`SELECT id FROM pub_museum WHERE slug = ${slug}`.execute(db);
    const museumId = found.rows[0]?.id;
    if (museumId === undefined) {
      const current = await findRedirect(db, slug);
      if (current === null) throw new ApiError('not_found');
      c.header('Cache-Control', CACHE_REDIRECT);
      c.header('Location', `/api/v1/museums/${current}/reviews`);
      return c.body(null, 301);
    }
    try {
      return sendJson(c, ReviewList, await reviewsOfMuseum(db, museumId, q), CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidReviewCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });
}
