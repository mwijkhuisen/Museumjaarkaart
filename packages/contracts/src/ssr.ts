// The boundary between the `ssr` role (apps/server) and the SSR bundle (apps/web), P1c, A§15.1.
// Types only: the server loads the built bundle at run time and checks its shape.

/** One in-process answer of an `/api/v1` GET: the status, a 301's `Location`, a 200's JSON. */
export type ApiResult = { status: number; location: string | null; body: unknown };

/** Runs the api's own catalogue route for `path` (`/api/v1/…`, with its query). */
export type FetchApi = (path: string) => Promise<ApiResult>;

/** Validated config (A§17.3): the brand and the public host name. */
export type SsrConfig = { brand: string; domain: string };

/** A finished document. `page` is a fixed code for the log line, never the path. */
export type SsrResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  page: string;
};

export type SsrBundle = {
  /** `path` is the pathname plus the query string of the request, never a Host-derived URL. */
  render(path: string, fetchApi: FetchApi, config: SsrConfig): Promise<SsrResponse>;
  /** `sitemap.xml` for the visible museums' slugs. */
  sitemap(slugs: readonly string[], config: SsrConfig): string;
};
