import { EmptyQuery, Provinces } from '@mjk/contracts';
import { listProvinces } from '../../museums/reference.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PUBLIC } from '../cache.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/** GET /provinces: the 12 provinces with their counts of visible museums. */
export function mountProvinces(v1: ApiApp, deps: ApiDeps): void {
  v1.get('/provinces', async (c) => {
    parseQuery(c, EmptyQuery);
    return sendJson(c, Provinces, { items: (await listProvinces(deps.db)) as Provinces['items'] }, CACHE_PUBLIC);
  });
}
