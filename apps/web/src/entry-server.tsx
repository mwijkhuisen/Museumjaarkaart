import './lib/zod.ts';
import './styles.css';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import type { FetchApi, SsrConfig, SsrResponse } from '@mjk/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { App } from './App.tsx';
import { createQueryClient } from './lib/api.ts';
import { type Assets, documentHtml } from './lib/document.ts';
import { apiPathsOf, type Locale, pathOf, type Route, routeOf } from './lib/routes.ts';
import { type ErrorKind, errorHeadOf, Head, type HeadData, headOf, jsonLdOf } from './lib/seo/head.tsx';
import { sitemapXml } from './lib/seo/sitemap.ts';
import { overwriteServerAsyncLocalStorage } from './paraglide/runtime.js';

// The SSR bundle the `ssr` role imports (A§15.1, ADR-0009). It never sees a request: only the path
// and query, the api's own answers (fetchApi) and the config. The locale of each render lives in
// an AsyncLocalStorage that Paraglide's getLocale() reads, so concurrent NL and EN renders never mix.

const renders = new AsyncLocalStorage<{ locale?: Locale }>();
overwriteServerAsyncLocalStorage(renders);

const HTML = 'text/html; charset=utf-8';
const CACHE_PUBLIC = 'public, max-age=0, s-maxage=60';
const CACHE_REDIRECT = 'public, max-age=0, s-maxage=3600';
const CACHE_PRIVATE = 'private, no-store';

type Chunk = { file: string; css?: string[]; imports?: string[] };

let assetsCache: Assets | undefined;

/** The client entry's files from Vite's manifest, next to this bundle (`dist/client`, `dist/server`). */
function assets(): Assets {
  if (assetsCache !== undefined) return assetsCache;
  const url = new URL('../client/.vite/manifest.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(url, 'utf8')) as Record<string, Chunk>;
  const entry = manifest['src/entry-client.tsx'];
  if (entry === undefined) throw new Error('manifest_without_entry');
  const css = new Set<string>();
  const preload = new Set<string>();
  const walk = (chunk: Chunk, isEntry: boolean) => {
    for (const file of chunk.css ?? []) css.add(`/${file}`);
    if (!isEntry) preload.add(`/${chunk.file}`);
    for (const key of chunk.imports ?? []) {
      const dep = manifest[key];
      if (dep !== undefined) walk(dep, false);
    }
  };
  walk(entry, true);
  assetsCache = { script: `/${entry.file}`, css: [...css], preload: [...preload] };
  return assetsCache;
}

async function markup(element: ReactElement): Promise<string> {
  const { prelude } = await prerender(element);
  return new Response(prelude).text();
}

async function document(
  route: Route,
  path: string,
  config: SsrConfig,
  page: { state: Record<string, unknown>; head: HeadData; jsonLd: object | null; fallback: ErrorKind | null },
): Promise<string> {
  const queryClient = createQueryClient();
  for (const [key, data] of Object.entries(page.state)) queryClient.setQueryData([key], data);
  const app = await markup(
    <App
      path={path}
      queryClient={queryClient}
      config={{ brand: config.brand }}
      {...(page.fallback === null ? {} : { fallback: page.fallback })}
    />,
  );
  return documentHtml({
    locale: route.locale,
    head: renderToStaticMarkup(<Head head={page.head} />),
    app,
    assets: assets(),
    hydrate: page.fallback === null,
    state: page.state,
    jsonLd: page.jsonLd,
  });
}

const KIND: Record<number, ErrorKind> = { 400: 'bad_request', 404: 'not_found' };

async function errorDocument(status: number, route: Route, path: string, config: SsrConfig, page: string) {
  const kind = KIND[status] ?? 'error';
  const body = await document(route, path, config, {
    state: {},
    head: errorHeadOf(kind, route.locale, config),
    jsonLd: null,
    fallback: kind,
  });
  return { status, headers: { 'Content-Type': HTML, 'Cache-Control': CACHE_PRIVATE }, body, page };
}

const redirect = (location: string, page: string): SsrResponse => ({
  status: 301,
  headers: { Location: location, 'Cache-Control': CACHE_REDIRECT },
  body: '',
  page,
});

/** The current slug from a moved museum's `Location: /api/v1/museums/<slug>`, or null. */
function movedSlug(location: string | null): string | null {
  const prefix = '/api/v1/museums/';
  if (location === null || !location.startsWith(prefix)) return null;
  const slug = location.slice(prefix.length);
  const resolved = routeOf(`/musea/${slug}`);
  return resolved.kind === 'route' && resolved.route.page === 'museum' ? slug : null;
}

async function renderRoute(route: Route, path: string, fetchApi: FetchApi, config: SsrConfig): Promise<SsrResponse> {
  if (route.page === 'not_found') return errorDocument(404, route, path, config, 'not_found');
  const paths = apiPathsOf(route);
  const results = await Promise.all(paths.map((p) => fetchApi(p)));
  // In apiPathsOf order, whatever order the answers came in: the HTML is the same bytes every time.
  const state: Record<string, unknown> = {};
  for (const [i, result] of results.entries()) {
    if (result.status === 200) {
      state[paths[i] as string] = result.body;
      continue;
    }
    if (result.status === 301 && route.page === 'museum') {
      const slug = movedSlug(result.location);
      if (slug !== null) return redirect(pathOf({ ...route, slug }), 'museum_moved');
    }
    if (result.status === 400 || result.status === 404)
      return errorDocument(result.status, route, path, config, route.page);
    return errorDocument(result.status === 503 ? 503 : 500, route, path, config, 'api_error');
  }
  const data = new Map(Object.entries(state));
  const body = await document(route, path, config, {
    state,
    head: headOf(route, data, config),
    jsonLd: jsonLdOf(route, data, config),
    fallback: null,
  });
  return { status: 200, headers: { 'Content-Type': HTML, 'Cache-Control': CACHE_PUBLIC }, body, page: route.page };
}

/** One page. A render failure answers the error page; only a failure of that escapes to the server. */
export async function render(path: string, fetchApi: FetchApi, config: SsrConfig): Promise<SsrResponse> {
  const resolved = routeOf(path);
  if (resolved.kind === 'redirect') return redirect(resolved.location, 'redirect');
  const { route } = resolved;
  return renders.run({ locale: route.locale }, async () => {
    try {
      return await renderRoute(route, path, fetchApi, config);
    } catch {
      return errorDocument(500, route, path, config, 'render_failed');
    }
  });
}

export function sitemap(slugs: readonly string[], config: SsrConfig): string {
  return sitemapXml(slugs, config);
}
