import { ErrorBody } from '@mjk/contracts';
import { QueryClient, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';

// The client's side of "same data, same contract" (A§15.1): the query key is the `/api/v1` path,
// the server seeds the cache from `mjk-state` under the same keys, and every fetched answer is
// parsed with its contract (A§14; jitless Zod, lib/zod.ts).

/** A non-2xx answer; the error boundary shows the not-found page for 400 and 404. */
export class ApiFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`api_${status}`);
    this.status = status;
  }
}

export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  fetcher: typeof fetch = fetch,
): Promise<z.output<S>> {
  const res = await fetcher(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiFailure(res.status);
  return schema.parse(await res.json());
}

/** A non-2xx answer to a mutation (A§14: `{"error":"<code>","fields":[…]}`). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: readonly string[];
  /** Seconds, from the `Retry-After` header of a 429; null when absent. */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, fields: readonly string[], retryAfter: number | null) {
    super(`api_${status}_${code}`);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/**
 * A request with a JSON body (or none), same origin. No CSRF header: the browser's `Origin` and
 * `Sec-Fetch-Site` are the check (A§9). A non-2xx answer throws ApiError; a 2xx is parsed with
 * `schema` when given (the 202s and 204s without one give undefined).
 */
export async function sendJson(method: string, path: string, body?: unknown): Promise<void>;
export async function sendJson<S extends z.ZodType>(
  method: string,
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>>;
export async function sendJson(method: string, path: string, body?: unknown, schema?: z.ZodType): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data.error : 'unknown',
      parsed.success ? (parsed.data.fields ?? []) : [],
      Number.isFinite(retry) && retry >= 0 ? retry : null,
    );
  }
  return schema === undefined ? undefined : schema.parse(await res.json());
}

/**
 * Catalogue data is fresh for the page's life: what `mjk-state` holds is never fetched again
 * (P1c criterion), and nothing refetches on focus or reconnect.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        throwOnError: true,
      },
    },
  });
}

/** One API path's data: undefined while a client-side navigation loads it. */
export function useApi<S extends z.ZodType>(path: string, schema: S): z.output<S> | undefined {
  return useQuery({ queryKey: [path], queryFn: () => getJson(path, schema) }).data;
}
