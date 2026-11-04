import { readFileSync } from 'node:fs';
import {
  CATEGORIES,
  CBS_CODE_RE,
  LIMITS,
  MUSEUMKAART_STATUSES,
  NL_BOX,
  PHOTO_POLICIES,
  POSTCODE_RE,
  PROVINCE_CODES,
  SLUG_MAX,
} from '@mjk/contracts';
import { expect, it } from 'vitest';
import * as fields from '../src/museums/fields.ts';

it('the contracts constants equal the server fields', () => {
  expect(CATEGORIES).toEqual(fields.CATEGORIES);
  expect(MUSEUMKAART_STATUSES).toEqual(fields.MUSEUMKAART_STATUSES);
  expect(PHOTO_POLICIES).toEqual(fields.PHOTO_POLICIES);
  expect(NL_BOX).toEqual(fields.NL_BOX);
  expect(SLUG_MAX).toBe(fields.LIMITS.slug);
  expect(POSTCODE_RE.source).toBe(fields.POSTCODE.source);
  expect(CBS_CODE_RE.source).toBe(fields.CBS_CODE.source);
  for (const [k, v] of Object.entries(LIMITS)) expect(v, k).toBe(fields.LIMITS[k as keyof typeof fields.LIMITS]);
});

it('PROVINCE_CODES equals the codes of the reference migration', () => {
  const sql = readFileSync(
    new URL('../../../db/migrations/20261102000001_museum_reference.sql', import.meta.url),
    'utf8',
  );
  const codes = [...sql.matchAll(/^\s*\('(NL-[A-Z]{2})',/gm)].map((m) => m[1]);
  expect(codes).toHaveLength(12);
  expect([...PROVINCE_CODES]).toEqual(codes);
});
