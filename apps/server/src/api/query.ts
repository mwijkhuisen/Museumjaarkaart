import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError, errorFields } from './errors.ts';

// Strict request parsing (A§14 "Requests"): every route parses its query string with a strict
// schema from @mjk/contracts, so an unknown or repeated parameter is a 400, and parses its path
// parameters before any value reaches SQL (the 22P02 gotcha: PostgreSQL logs a bad cast's value).

/**
 * The query string as one value per name, parsed by `schema`. A repeated name is a 400 (the field
 * named only when the schema knows it). Built from URLSearchParams with Object.fromEntries, so a
 * name such as `__proto__` is an own key that the strict schema refuses.
 */
export function parseQuery<S extends z.ZodObject>(c: Context, schema: S): z.output<S> {
  const params = new URL(c.req.url).searchParams;
  const seen = new Map<string, string>();
  for (const [name, value] of params) {
    if (seen.has(name)) throw new ApiError('bad_request', Object.hasOwn(schema.shape, name) ? [name] : []);
    seen.set(name, value);
  }
  const parsed = schema.safeParse(Object.fromEntries(seen));
  if (!parsed.success) throw new ApiError('bad_request', errorFields(parsed.error));
  return parsed.data;
}

/** One path parameter, parsed by `schema`; a failure is a 400 naming `name`. */
export function parseParam<S extends z.ZodType>(name: string, value: string | undefined, schema: S): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('bad_request', [name]);
  return parsed.data;
}
