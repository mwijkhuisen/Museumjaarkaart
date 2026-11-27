import { buildApp, type Mount } from '../../src/api/app.ts';
import { mountMeMuseums } from '../../src/api/routes/me-museums.ts';
import { mountMeVisits } from '../../src/api/routes/me-visits.ts';
import { mountMeWishlist } from '../../src/api/routes/me-wishlist.ts';
import { mountReviews } from '../../src/api/routes/reviews.ts';
import { mountReviewsPublic } from '../../src/api/routes/reviews-public.ts';
import { mountUsers } from '../../src/api/routes/users.ts';
import { createDb } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { meApp } from '../api/me-app.ts';
import type { PassportDb } from '../passport/fixtures.ts';

// P3a WP3's fixture: the review routes (writes and reads), the visit log, the member's museum view and the
// public profile over meApp (the session cookie, same-origin headers, a client address we choose), plus the
// public reads as mjk_ssr, the way the ssr role's in-process app serves them.

export const mountReviewRoutes: Mount = (v1, d) => {
  mountReviews(v1, d);
  mountReviewsPublic(v1, d);
  mountUsers(v1, d);
  mountMeVisits(v1, d);
  mountMeMuseums(v1, d);
  mountMeWishlist(v1, d);
};

export function reviewsApp(p: PassportDb) {
  const t = meApp(p, mountReviewRoutes);
  const ssrApp = buildApp({ db: createDb(p.pools.ssr), logger: silentLogger, ping: async () => true }, (v1, d) => {
    mountReviewsPublic(v1, d);
    mountUsers(v1, d);
  });
  /** A public GET as mjk_ssr, no cookie. */
  const ssrGet = (path: string) => ssrApp.request(`http://localhost/api/v1${path}`);
  return { ...t, ssrGet };
}

const OPEN = `(closed_on IS NULL OR closed_on > (now() AT TIME ZONE 'Europe/Amsterdam')::date)`;

/** A visible museum that is not closed, the n-th in id order. */
export async function openMuseum(p: PassportDb, n = 0): Promise<{ id: string; slug: string }> {
  const r = await p.owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM museum WHERE NOT hidden AND ${OPEN} ORDER BY id OFFSET $1 LIMIT 1`,
    [n],
  );
  return r.rows[0] as { id: string; slug: string };
}

/** A visible museum whose closed_on has passed. */
export async function closedMuseum(p: PassportDb): Promise<{ id: string; slug: string }> {
  const r = await p.owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM museum WHERE NOT hidden AND closed_on <= (now() AT TIME ZONE 'Europe/Amsterdam')::date
      ORDER BY id LIMIT 1`,
  );
  return r.rows[0] as { id: string; slug: string };
}

/** A member with a session and one visit to `museumId`. */
export async function memberWithVisit(
  p: PassportDb,
  t: ReturnType<typeof reviewsApp>,
  museumId: string,
  opts: { on?: string | null } = {},
) {
  const u = await p.newMember();
  const token = await t.signIn(u.id);
  const visitId = await p.addVisit(u.id, museumId, opts.on === undefined ? {} : { on: opts.on });
  return { ...u, token, visitId };
}
