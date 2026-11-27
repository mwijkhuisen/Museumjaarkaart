import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError, errorFields } from './errors.ts';
import type { ApiEnv } from './middleware/request.ts';

// The one JSON body reader (A§14). By the time a route calls it, the body cap has refused a
// Transfer-Encoding and any Content-Length over its cap (`bodyLimit`), and jsonOnly a non-JSON type. Here:
//   - no body (no Content-Length, or 0) → the schema sees `undefined`, so a route that needs a body
//     answers 400, and the fields name what is missing;
//   - the bytes read must equal the Content-Length (A§14: every route that reads a body counts what
//     it reads; the request log records a mismatch as `body: "mismatch"`, never the content);
//   - invalid JSON → 400 with `fields: []`; a schema failure → 400 with the failing paths only.

export async function readJson<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): Promise<z.output<S>> {
  const declared = c.req.header('content-length');
  const expected = declared === undefined ? 0 : Number(declared.trim());
  let value: unknown;
  if (expected > 0) {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength !== expected) {
      c.set('bodyMismatch', true);
      throw new ApiError('bad_request', []);
    }
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ApiError('bad_request', []);
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('bad_request', errorFields(parsed.error));
  return parsed.data;
}
