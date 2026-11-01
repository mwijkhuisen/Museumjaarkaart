import { expect, it } from 'vitest';
import { backoff } from '../../src/worker/backoff.ts';

const MIN = 60_000;

it('doubles from 15 minutes per attempt', () => {
  expect(backoff(1)).toBe(15 * MIN);
  expect(backoff(2)).toBe(30 * MIN);
  expect(backoff(3)).toBe(60 * MIN);
  expect(backoff(4)).toBe(120 * MIN);
  expect(backoff(5)).toBe(240 * MIN);
});

it('is capped at 6 hours', () => {
  expect(backoff(6)).toBe(360 * MIN);
  expect(backoff(7)).toBe(360 * MIN);
  expect(backoff(20)).toBe(360 * MIN);
  expect(backoff(10_000)).toBe(360 * MIN);
});

it('treats an attempt below 1 as the first', () => {
  expect(backoff(0)).toBe(15 * MIN);
  expect(backoff(-3)).toBe(15 * MIN);
});
