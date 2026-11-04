import { z } from 'zod';
import { CategorySchema, CbsCode, Cursor, NL_BOX, ProvinceCodeSchema, SLUG_MAX, SLUG_RE } from './common.ts';

// Every value arrives as a string from the URL. Output types are the parsed values.

const CONTROL_RE = /\p{Cc}/u;

export const Q = z
  .string()
  .max(1000)
  .refine((s) => s.isWellFormed(), { message: 'ill-formed' })
  .refine((s) => !CONTROL_RE.test(s), { message: 'control character' })
  .transform((s) => s.trim())
  .pipe(z.string().refine((s) => [...s].length >= 1 && [...s].length <= 100, { message: 'length' }));

export const Limit = z
  .string()
  .regex(/^[1-9][0-9]?$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(50))
  .prefault('20');

export const LatParam = z
  .string()
  .regex(/^-?[0-9]{1,2}(\.[0-9]{1,3})?$/)
  .transform(Number)
  .pipe(z.number().min(NL_BOX.latMin).max(NL_BOX.latMax));

export const LonParam = z
  .string()
  .regex(/^-?[0-9]{1,3}(\.[0-9]{1,3})?$/)
  .transform(Number)
  .pipe(z.number().min(NL_BOX.lonMin).max(NL_BOX.lonMax));

export const MuseumListQuery = z.strictObject({
  q: Q.optional(),
  province: ProvinceCodeSchema.optional(),
  municipality: CbsCode.optional(),
  category: CategorySchema.optional(),
  mk: z.literal('participating').optional(),
  sort: z.enum(['rank', 'name']).prefault('rank'),
  limit: Limit,
  cursor: Cursor.optional(),
});
export type MuseumListQuery = z.infer<typeof MuseumListQuery>;
export type MuseumListQueryInput = z.input<typeof MuseumListQuery>;

export const SuggestQuery = z.strictObject({ q: Q });
export type SuggestQuery = z.infer<typeof SuggestQuery>;

export const NearQuery = z.strictObject({ lat: LatParam, lon: LonParam, limit: Limit });
export type NearQuery = z.infer<typeof NearQuery>;
export type NearQueryInput = z.input<typeof NearQuery>;

export const EmptyQuery = z.strictObject({});
export type EmptyQuery = z.infer<typeof EmptyQuery>;

export const SlugParam = z.string().max(SLUG_MAX).regex(SLUG_RE);
export type SlugParam = z.infer<typeof SlugParam>;
