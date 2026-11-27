import type { FetchApi, SsrBundle, SsrConfig } from '@mjk/contracts';
import { type Context, Hono } from 'hono';
import { unavailable } from '../api/app.ts';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';

// The `ssr` role's Hono app (A§5, A§14, A§15.1). It reads no request header and no cookie and sets
// none: the only request input is the pathname and query, so a response never depends on who asks
// (criterion 5). Absolute URLs come from config.domain, never from Host. One log line per request
// holds a fixed page code, never the path or query (invariant 8).

export type SsrDeps = {
  bundle: SsrBundle;
  /** The api's own catalogue routes, in-process. */
  fetchApi: FetchApi;
  /** The pool as mjk_ssr: only the sitemap reads it directly. */
  db: Db;
  config: SsrConfig;
  logger: Logger;
};

const CACHE_PRIVATE = 'private, no-store';
const CACHE_STATIC = 'public, max-age=0, s-maxage=3600';
const TEXT = 'text/plain; charset=utf-8';
const ROBOTS = 'User-agent: *\nDisallow:\n';

type SsrEnv = { Variables: { page: string } };

export function createSsrApp({ bundle, fetchApi, db, config, logger }: SsrDeps): Hono<SsrEnv> {
  const app = new Hono<SsrEnv>();
  const page = (c: Context<SsrEnv>, code: string) => c.set('page', code);

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      { page: c.get('page') ?? 'error', status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  });

  // Hono answers HEAD from the GET handlers (headers and status, no body).
  app.get('/robots.txt', (c) => {
    page(c, 'robots');
    return new Response(ROBOTS, { headers: { 'Content-Type': TEXT, 'Cache-Control': CACHE_STATIC } });
  });

  app.get('/sitemap.xml', async (c) => {
    page(c, 'sitemap');
    const rows = await db.selectFrom('pub_museum').select('slug').orderBy('slug').execute();
    // Only members who opted in (default: not); `pub_profile` holds active members only.
    const profiles = await db
      .selectFrom('pub_profile')
      .select('handle')
      .where('indexable', '=', true)
      .orderBy('handle')
      .execute();
    const body = bundle.sitemap(
      rows.map((r) => r.slug as string),
      profiles.map((r) => r.handle as string),
      config,
    );
    return new Response(body, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': CACHE_STATIC },
    });
  });

  app.get('*', async (c) => {
    const url = new URL(c.req.url);
    const r = await bundle.render(url.pathname + url.search, fetchApi, config);
    page(c, r.page);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });

  app.all('*', (c) => {
    page(c, 'method_not_allowed');
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': CACHE_PRIVATE } });
  });

  app.onError((err, c) => {
    // Never the message or the stack: either can quote data.
    if (unavailable(err)) logger.warn({}, 'db_unavailable');
    else logger.error({}, 'render_failed');
    page(c, 'error');
    return new Response('Internal Server Error\n', {
      status: 500,
      headers: { 'Content-Type': TEXT, 'Cache-Control': CACHE_PRIVATE },
    });
  });

  return app;
}
