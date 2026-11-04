import { MuseumList, MuseumListQuery, Suggest, SuggestQuery } from '@mjk/contracts';
import { InvalidCursor, listMuseums } from '../../museums/query.ts';
import { suggestMuseums } from '../../museums/search.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /museums and GET /museums/suggest (A§14). Register before /museums/:slug: the first
 * registered route answers.
 */
export function mountMuseumsList(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/museums', async (c) => {
    const query = parseQuery(c, MuseumListQuery);
    try {
      const list = await listMuseums(deps.db, query);
      return sendJson(c, MuseumList, list, CACHE_PUBLIC);
    } catch (err) {
      if (err instanceof InvalidCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });

  v1.get('/museums/suggest', async (c) => {
    const { q } = parseQuery(c, SuggestQuery);
    const items = await suggestMuseums(deps.db, q);
    return sendJson(c, Suggest, { items }, CACHE_PUBLIC);
  });
}
