import { MuseumPoints, PointsQuery } from '@mjk/contracts';
import { listPoints } from '../../museums/query.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_POINTS } from '../cache.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /museums/points (A§14, A§15.3): the map's points, the same filters as GET /museums, no paging.
 * Register before /museums/:slug: the first registered route answers.
 */
export function mountMuseumsPoints(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/museums/points', async (c) => {
    const query = parseQuery(c, PointsQuery);
    return sendJson(c, MuseumPoints, await listPoints(deps.db, query), CACHE_POINTS);
  });
}
