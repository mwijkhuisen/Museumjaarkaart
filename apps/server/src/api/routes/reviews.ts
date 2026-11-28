import { EmptyQuery, OwnReview, ReviewCreate, ReviewIdParam, ReviewPatch } from '@mjk/contracts';
import type { Context } from 'hono';
import type { z } from 'zod';
import { BUCKETS, enforce, hit, userKey } from '../../auth/limiter.ts';
import type { Db } from '../../db/kysely.ts';
import type { Logger } from '../../lib/log.ts';
import { createReview, deleteReview, editReview, ownReview } from '../../reviews/service.ts';
import { enqueueStats } from '../../reviews/stats-queue.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { type ClientAddress, clientOr429 } from '../middleware/client-address.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { requireMember, requirePoster } from '../middleware/session.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The review writes (A§9, A§14, P3a): create, edit and delete one's own review. Every query is keyed on the
// session's user, so another member's review is a 404, never a 403. Create and edit need the current terms
// (`requirePoster`); delete does not. POST and PATCH count against 20 a day per member, hit inside the
// transaction after every check, so a refused or failed write counts for nothing and leaves no row. Each
// writes one `content_ip_log` row (the client address, 30 days) and queues the stats recompute.
// Nothing here is logged but fixed codes: the request log never holds a body, an id or an address.

/** A review id from the path: anything but a uuid is a 404 before SQL (the 22P02 gotcha). */
const reviewId = (raw: string | undefined): string => {
  const parsed = ReviewIdParam.safeParse(raw);
  if (!parsed.success) throw new ApiError('not_found');
  return parsed.data;
};

/**
 * The request body. Schema failures are 400 (A§14), except that a body text the rule refuses (a control or bidi
 * character, over 5,000 code points) is a 422 `["body"]` and a `media_ids` list the schema refuses (an 11th, a
 * duplicate, not a uuid) a 422 `["media_ids"]`: the member's content, not the request's shape, is at fault.
 * ponytail: a body of the wrong JSON type also names only `body` and so also answers 422.
 */
async function readReview<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): Promise<z.output<S>> {
  try {
    return await readJson(c, schema);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'bad_request' && err.fields !== undefined) {
      if (err.fields.join() === 'body') throw new ApiError('invalid', ['body']);
      if (err.fields.length > 0 && err.fields.every((f) => f === 'media_ids' || f.startsWith('media_ids.')))
        throw new ApiError('invalid', ['media_ids']);
    }
    throw err;
  }
}

/** The rate hit, the address log and the stats queue of one accepted write, on its transaction. */
async function afterWrite(
  trx: Db,
  d: { logger: Logger; keys: NonNullable<ApiDeps['keys']> },
  userId: string,
  reviewId: string,
  client: ClientAddress,
): Promise<void> {
  enforce(d.logger, BUCKETS.reviewUserDay, await hit(trx, BUCKETS.reviewUserDay, userKey(d.keys, 'review', userId)));
  await trx
    .insertInto('content_ip_log')
    .values({ user_id: userId, target_kind: 'review', target_id: reviewId, ip: client.address })
    .execute();
  await enqueueStats(trx);
}

export function mountReviews(v1: ApiApp, deps: ApiDeps): void {
  const { db, logger, keys } = deps;
  if (keys === undefined) throw new Error('reviews_need_keys');
  const d = { logger, keys };

  v1.post('/reviews', async (c) => {
    const userId = requirePoster(c).user.id;
    parseQuery(c, EmptyQuery);
    const body = await readReview(c, ReviewCreate);
    const client = clientOr429(c, logger, BUCKETS.reviewUserDay);
    const own = await db.transaction().execute(async (trx) => {
      const made = await createReview(trx, userId, { ...body, body: body.body ?? null });
      if (!made.ok) {
        if (made.reason === 'museum_unknown') throw new ApiError('invalid', ['museum_id']);
        if (made.reason === 'visit_not_own') throw new ApiError('invalid', ['visit_id']);
        if (made.reason === 'media_ids') throw new ApiError('invalid', ['media_ids']); // rolls the create back
        throw new ApiError('conflict'); // museum_closed, review_exists
      }
      await afterWrite(trx, d, userId, made.id, client);
      const row = await ownReview(trx, userId, made.id);
      if (row === undefined) throw new Error('review_vanished');
      return row;
    });
    return sendJson(c, OwnReview, own, CACHE_PRIVATE, 201);
  });

  v1.patch('/reviews/:id', async (c) => {
    const userId = requirePoster(c).user.id;
    const id = reviewId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    const patch = await readReview(c, ReviewPatch);
    const client = clientOr429(c, logger, BUCKETS.reviewUserDay);
    const own = await db.transaction().execute(async (trx) => {
      const done = await editReview(trx, userId, id, patch);
      if (!done.ok) {
        if (done.reason === 'not_found') throw new ApiError('not_found');
        if (done.reason === 'visit_not_own') throw new ApiError('invalid', ['visit_id']);
        throw new ApiError('conflict'); // museum_closed
      }
      await afterWrite(trx, d, userId, id, client);
      const row = await ownReview(trx, userId, id);
      if (row === undefined) throw new Error('review_vanished');
      return row;
    });
    return sendJson(c, OwnReview, own, CACHE_PRIVATE);
  });

  // Allowed without the current terms and on a closed museum; no rate limit (it removes content).
  v1.delete('/reviews/:id', async (c) => {
    const userId = requireMember(c).user.id;
    const id = reviewId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    await db.transaction().execute(async (trx) => {
      if (!(await deleteReview(trx, userId, id))) throw new ApiError('not_found');
      await enqueueStats(trx);
    });
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });
}
