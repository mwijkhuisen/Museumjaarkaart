import { EmptyQuery, Marks, Wishlist } from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { settingsOf } from '../../auth/me.ts';
import { toVisitMuseum } from '../../passport/visits.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The wishlist and the marks (A§10). Marks and the member list count visible museums only; the wishlist
// itself names a museum hidden later without a link, like a visit.

export function mountMeWishlist(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;

  v1.get('/me/wishlist', async (c) => {
    const session = requireMember(c);
    parseQuery(c, EmptyQuery);
    const { rows } = await sql<{
      created_at: Date;
      museum_id: string;
      slug: string | null;
      name: string;
      name_en: string | null;
      place: string | null;
    }>`SELECT w.created_at, m.id AS museum_id, CASE WHEN m.hidden THEN NULL ELSE m.slug END AS slug,
              m.name, m.name_en, m.place
         FROM wishlist w JOIN museum m ON m.id = w.museum_id
        WHERE w.user_id = ${session.user.id}::uuid
        ORDER BY w.created_at DESC, w.museum_id DESC`.execute(db);
    const items = rows.map((r) => ({ museum: toVisitMuseum(r), created_at: r.created_at.toISOString() }));
    return sendJson(c, Wishlist, { items }, CACHE_PRIVATE);
  });

  v1.put('/me/wishlist/:museum_id', async (c) => {
    const session = requireMember(c);
    const museumId = parseParam('museum_id', c.req.param('museum_id'), z.uuid());
    const museum = await sql`SELECT 1 FROM museum WHERE id = ${museumId}::uuid AND NOT hidden`.execute(db);
    if (museum.rows.length === 0) throw new ApiError('not_found');
    await sql`INSERT INTO wishlist (user_id, museum_id) VALUES (${session.user.id}::uuid, ${museumId}::uuid)
      ON CONFLICT DO NOTHING`.execute(db);
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });

  v1.delete('/me/wishlist/:museum_id', async (c) => {
    const session = requireMember(c);
    const museumId = parseParam('museum_id', c.req.param('museum_id'), z.uuid());
    await db.deleteFrom('wishlist').where('user_id', '=', session.user.id).where('museum_id', '=', museumId).execute();
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });

  // Public pages call this after hydration, so signed out is a 200 with null, like GET /me.
  v1.get('/me/marks', async (c) => {
    parseQuery(c, EmptyQuery);
    const session = c.var.session;
    if (session === undefined) return sendJson(c, Marks, { marks: null }, CACHE_PRIVATE);
    const marked = (table: 'visit' | 'wishlist') =>
      sql<{ museum_id: string }>`SELECT DISTINCT t.museum_id FROM ${sql.table(table)} t
        JOIN museum m ON m.id = t.museum_id
       WHERE t.user_id = ${session.user.id}::uuid AND NOT m.hidden ORDER BY t.museum_id`
        .execute(db)
        .then((r) => r.rows.map((x) => x.museum_id));
    const [visited, wishlist] = await Promise.all([marked('visit'), marked('wishlist')]);
    return sendJson(
      c,
      Marks,
      {
        marks: {
          visited,
          wishlist,
          hide_ratings_until_visited: settingsOf(session.user.settings).hide_ratings_until_visited,
        },
      },
      CACHE_PRIVATE,
    );
  });
}
