import type { Aspect } from '@mjk/contracts';
import type { Db } from '../db/kysely.ts';

// The review writes (A§8, A§14, P3a). WP3 builds them; WP0 fixes the one create path's signature, which the
// CSV import's confirm (WP8) calls too.

/** A review as it is written: the rating, the optional aspects and the normalised body (null when empty). */
export type ReviewWrite = {
  museum_id: string;
  visit_id: string;
  rating: number;
  body: string | null;
} & { [A in Aspect]?: number | null };

/** Why a create was refused; the route maps each to its answer, the import to a row error. */
export type CreateRefusal = 'museum_unknown' | 'museum_closed' | 'visit_not_own' | 'review_exists';

export type CreateResult = { ok: true; id: string } | { ok: false; reason: CreateRefusal };

/**
 * The one create path (POST /reviews and the import's confirm), on the caller's transaction. It checks that the
 * museum is known, not hidden and not closed, that the visit is the member's own visit to that museum and that
 * the member has no review of it yet, then inserts. It never rate-limits, writes `content_ip_log` or queues the
 * recompute: the caller does each once.
 */
export async function createReview(_trx: Db, _userId: string, _input: ReviewWrite): Promise<CreateResult> {
  throw new Error('create_review_not_built');
}
