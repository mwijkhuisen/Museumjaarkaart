import type { ErrorCode } from '@mjk/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { CACHE_PRIVATE } from './cache.ts';

// Fixed errors (A§14): `{"error":"<code>"}`, plus `fields` on a 400 or 422 with the names of the
// failing schema paths. Never a value, a header, a parameter name the schema does not know, or a
// database message (invariant 8). A 429 carries `Retry-After` in whole seconds.

/** The codes this api answers (@mjk/contracts' ERROR_CODES, each with its A§14 status). */
export type ApiErrorCode = ErrorCode;

const STATUS: Readonly<Record<ApiErrorCode, ContentfulStatusCode>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  terms_required: 403,
  reauth_required: 403,
  banned: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported_type: 415,
  invalid: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

/** Thrown by a route or a parser; the error handler turns it into the fixed answer. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fields: readonly string[] | undefined;
  /** Seconds, for a 429 (`Retry-After`). */
  readonly retryAfter: number | undefined;
  constructor(code: ApiErrorCode, fields?: readonly string[], retryAfter?: number) {
    super(code);
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/** An answer failed its own contract: a bug, answered as 500 and logged as a fixed code. */
export class ContractMismatch extends Error {
  constructor() {
    super('contract_mismatch');
  }
}

const MAX_FIELDS = 50;

/**
 * The schema paths of a failed parse, joined with dots, sorted and unique. An unknown key is
 * reported by no path at all: its name is user input, not a schema path.
 */
export function errorFields(error: z.ZodError): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') continue;
    const path = issue.path.map(String).join('.');
    if (path !== '') paths.add(path.slice(0, 200));
  }
  return [...paths].sort().slice(0, MAX_FIELDS);
}

/** The fixed error answer, `private, no-store`; a 429 also carries `Retry-After` (≥ 1 s). */
export function respondError(
  c: Context,
  code: ApiErrorCode,
  fields?: readonly string[],
  retryAfter?: number,
): Response {
  c.header('Cache-Control', CACHE_PRIVATE);
  if (code === 'rate_limited') c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfter ?? 60))));
  return c.json(fields === undefined ? { error: code } : { error: code, fields: [...fields] }, STATUS[code]);
}
