import { EmptyQuery, MemberMuseum, MemberMuseumsQuery, MuseumList, SlugParam } from '@mjk/contracts';
import { sql } from 'kysely';
import { InvalidCursor, listMuseums } from '../../museums/query.ts';
import { visitsOfMuseum } from '../../passport/visits.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The catalogue as the member sees it (A§10, A§14): the museum list narrowed to what they have visited or
// wishlisted, and one museum's visits and wishlist flag. Visible museums only; no old-slug redirect here.

export function mountMeMuseums(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;

  v1.get('/me/museums', async (c) => {
    const session = requireMember(c);
    const { visited, wishlist, ...query } = parseQuery(c, MemberMuseumsQuery);
    try {
      const member = { userId: session.user.id, visited, wishlist };
      return sendJson(c, MuseumList, await listMuseums(db, { ...query, member }), CACHE_PRIVATE);
    } catch (err) {
      if (err instanceof InvalidCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });

  v1.get('/me/museums/:slug', async (c) => {
    const session = requireMember(c);
    const slug = parseParam('slug', c.req.param('slug'), SlugParam);
    parseQuery(c, EmptyQuery);
    const found = await sql<{ id: string }>`SELECT id FROM pub_museum WHERE slug = ${slug}`.execute(db);
    const museumId = found.rows[0]?.id;
    if (museumId === undefined) throw new ApiError('not_found');
    const userId = session.user.id;
    const [visits, wished] = await Promise.all([
      visitsOfMuseum(db, userId, museumId),
      sql`SELECT 1 FROM wishlist WHERE user_id = ${userId}::uuid AND museum_id = ${museumId}::uuid`.execute(db),
    ]);
    return sendJson(c, MemberMuseum, { visits, wishlist: wished.rows.length > 0 }, CACHE_PRIVATE);
  });
}
