import { EmptyQuery, MkList } from '@mjk/contracts';
import { currentMkList } from '../../museums/reference.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC } from '../cache.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/** GET /mk-list: the newest published list's date and N, or `{"list":null}`. */
export function mountMkList(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/mk-list', async (c) => {
    parseQuery(c, EmptyQuery);
    return sendJson(c, MkList, { list: await currentMkList(deps.db) }, CACHE_PUBLIC);
  });
}
