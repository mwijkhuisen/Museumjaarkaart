import { expect, it } from 'vitest';
import { type ProgressRow, progressOf } from '../../src/passport/progress.ts';

const row = (museum_id: string, over: Partial<ProgressRow> = {}): ProgressRow => ({
  museum_id,
  year: 2026,
  mk_list_member: false,
  province_code: 'NL-NH',
  ...over,
});
const LIST = { published_on: '2026-11-01', n: 5 };
const PROVINCES = [
  { code: 'NL-ZH', n: 2 },
  { code: 'NL-NH', n: 2 },
  { code: null, n: 1 },
];

it('no list published: no card figure, but all time and the years still count', () => {
  expect(progressOf([row('a'), row('b', { year: 2025 })], null, [])).toEqual({
    list: null,
    all_time: 2,
    years: [
      { year: 2026, museums: 1 },
      { year: 2025, museums: 1 },
    ],
  });
});

it('counts distinct museums: a museum visited twice, in two years, counts once overall and once a year', () => {
  const p = progressOf(
    [
      row('a', { mk_list_member: true }),
      row('a', { mk_list_member: true }),
      row('a', { year: 2025, mk_list_member: true }),
    ],
    LIST,
    PROVINCES,
  );
  expect(p.all_time).toBe(1);
  expect(p.list?.visited).toBe(1);
  expect(p.years).toEqual([
    { year: 2026, museums: 1 },
    { year: 2025, museums: 1 },
  ]);
});

it('the card list counts only members, in total and per province; N and the date are as published', () => {
  const p = progressOf(
    [
      row('a', { mk_list_member: true, province_code: 'NL-NH' }),
      row('b', { mk_list_member: true, province_code: 'NL-ZH' }),
      row('c', { mk_list_member: true, province_code: null }),
      row('d', { mk_list_member: false, province_code: 'NL-NH' }),
    ],
    LIST,
    PROVINCES,
  );
  expect(p.all_time).toBe(4);
  expect(p.list).toEqual({
    published_on: '2026-11-01',
    n: 5,
    visited: 3,
    provinces: [
      { code: 'NL-NH', n: 2, visited: 1 },
      { code: 'NL-ZH', n: 2, visited: 1 },
      { code: null, n: 1, visited: 1 },
    ],
  });
  expect(p.list?.provinces.reduce((s, x) => s + x.n, 0)).toBe(p.list?.n);
  expect(p.list?.provinces.reduce((s, x) => s + x.visited, 0)).toBe(p.list?.visited);
});

it('an undated visit counts for all time and the list but for no year', () => {
  const p = progressOf([row('a', { year: null, mk_list_member: true })], LIST, PROVINCES);
  expect(p.all_time).toBe(1);
  expect(p.list?.visited).toBe(1);
  expect(p.years).toEqual([]);
});

it('nothing visited: zeros, and every province still listed', () => {
  const p = progressOf([], LIST, PROVINCES);
  expect(p.all_time).toBe(0);
  expect(p.list?.visited).toBe(0);
  expect(p.list?.provinces).toHaveLength(3);
});
