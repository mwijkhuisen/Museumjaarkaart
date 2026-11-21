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
