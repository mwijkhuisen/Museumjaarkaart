import { EmptyQuery, MuseumDetail, SlugParam } from '@mjk/contracts';
import { lookupMuseum } from '../../museums/detail.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC, CACHE_REDIRECT } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/** GET /museums/:slug (A§14): 200, a 301 from an old slug, or 404. Register after /museums/suggest and /museums/near. */
export function mountMuseumDetail(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/museums/:slug', async (c) => {
    parseQuery(c, EmptyQuery);
    const slug = parseParam('slug', c.req.param('slug'), SlugParam);
    const found = await lookupMuseum(deps.db, slug);
    if (found.kind === 'missing') throw new ApiError('not_found');
    if (found.kind === 'moved') {
      c.header('Cache-Control', CACHE_REDIRECT);
      c.header('Location', `/api/v1/museums/${found.slug}`);
      return c.body(null, 301);
    }
    return sendJson(c, MuseumDetail, found.detail, CACHE_PUBLIC);
  });
}
