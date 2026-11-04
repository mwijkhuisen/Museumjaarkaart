import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { ContractMismatch } from './errors.ts';

/**
 * A JSON answer checked against its contract (A§14: every answer has a strict zod contract). A body
 * that fails its own contract is a bug: it throws, and the error handler answers 500 with a fixed code.
 */
export function sendJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  body: z.input<S>,
  cacheControl: string,
  status: ContentfulStatusCode = 200,
): Response {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ContractMismatch();
  c.header('Cache-Control', cacheControl);
  return c.json(parsed.data as object, status);
}
