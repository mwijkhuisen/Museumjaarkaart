import { NearList, NearQuery } from '@mjk/contracts';
import { findNearest } from '../../museums/near.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /museums/near?lat=&lon=&limit= (A§14, ADR-0015): the nearest visible museums. Positional, so
 * `private, no-store`, and the request log never holds the query (it logs the route pattern only).
 * Register before /museums/:slug: the first registered route answers.
 */
export function mountMuseumsNear(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/museums/near', async (c) => {
    const q = parseQuery(c, NearQuery);
    const { items } = await findNearest(deps.db, q);
    return sendJson(c, NearList, { items }, CACHE_PRIVATE);
  });
}
