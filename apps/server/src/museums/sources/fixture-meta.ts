// The `.meta.json` beside each museum fixture: where it came from and which query
// produced it (plan §2.2). `scripts/record-fixture.ts` writes it; tests read it.

import { z } from 'zod';
import { QID } from '../fields.ts';

export const FIXTURE_ORIGINS = ['synthetic', 'recorded'] as const;
export const FIXTURE_LICENCES = ['CC0-1.0', 'PDM-1.0'] as const;
/** `synthetic` is Wikidata's hand-made edge cases, kept when the owner recorded the real `edge` (O1). */
export const FIXTURE_CASES = ['normal', 'edge', 'empty', 'hostile', 'synthetic'] as const;

export const FixtureMeta = z.object({
  source: z.enum(['wikidata', 'rce']),
  case: z.string().min(1).max(40),
  origin: z.enum(FIXTURE_ORIGINS),
  /** `YYYY-MM-DD` (the date of the recording, or of writing a synthetic fixture). */
  recordedOn: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  licence: z.enum(FIXTURE_LICENCES),
  /** Wikidata only: the sha256 of `wikidata.sparql` the fixture was produced with. */
  querySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** A `VALUES`-restricted recording lists its items. */
  qids: z.array(z.string().regex(QID)).optional(),
  notes: z.string().max(4000).optional(),
});
export type FixtureMeta = z.infer<typeof FixtureMeta>;

export function parseFixtureMeta(json: unknown): FixtureMeta | undefined {
  const r = FixtureMeta.safeParse(json);
  return r.success ? r.data : undefined;
}
