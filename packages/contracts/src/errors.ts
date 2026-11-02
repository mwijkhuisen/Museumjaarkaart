import { z } from 'zod';

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'terms_required',
  'reauth_required',
  'banned',
  'not_found',
  'conflict',
  'too_large',
  'unsupported_type',
  'invalid',
  'rate_limited',
  'internal',
  'unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBody = z.strictObject({
  error: z.enum(ERROR_CODES),
  fields: z.array(z.string().max(200)).max(50).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
