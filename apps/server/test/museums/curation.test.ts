import { expect, it } from 'vitest';
import { formatInstant, parseDate, parseInstantMs, startOfDayMs } from '../../src/admin/dates.ts';
import { type Curated, diffPatch } from '../../src/museums/curation.ts';

const base: Curated = {
  museumkaart_status: 'unknown',
  mk_since: null,
  mk_until: null,
  mk_last_verified_at: null,
  admission_adult_cents: null,
  price_verified_at: null,
  photo_policy: 'unknown',
  closed_on: null,
  temp_closed: false,
  temp_closed_until: null,
  hidden: false,
};

it('diffPatch lists only the columns whose value differs, in CSV order', () => {
  expect(diffPatch(base, { hidden: true, museumkaart_status: 'unknown', mk_since: '2020-01-01' })).toEqual([
    'mk_since',
    'hidden',
  ]);
  expect(diffPatch(base, { ...base })).toEqual([]);
});

it('parseDate accepts real calendar days only', () => {
  expect(parseDate('2026-02-28')).toBe('2026-02-28');
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', '2026-01-01T00:00']) {
    expect(parseDate(bad)).toBeUndefined();
  }
});

it('the start of a day is taken in Europe/Amsterdam', () => {
  expect(formatInstant(startOfDayMs('2026-07-01'))).toBe('2026-07-01T00:00:00+02:00');
  expect(formatInstant(startOfDayMs('2026-12-01'))).toBe('2026-12-01T00:00:00+01:00');
  expect(parseInstantMs('2026-12-01T00:00:00+01:00')).toBe(startOfDayMs('2026-12-01'));
  expect(parseInstantMs('2026-12-01')).toBeUndefined();
});
