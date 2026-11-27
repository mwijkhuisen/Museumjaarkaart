import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ASPECT_MIN, BAYES_C, bayes } from '../../src/reviews/score.ts';

describe('bayes', () => {
  it('pins the owner constants (Q2, Q3)', () => {
    expect(BAYES_C).toBe(5);
    expect(ASPECT_MIN).toBe(3);
  });

  it('is (c·m + sum) / (c + n), computed by hand', () => {
    // (5 · 4.2 + 5) / 6 = 26 / 6
    expect(bayes(5, 4.2, [5])).toBeCloseTo(26 / 6, 12);
    // (5 · 4.2 + 184) / 45 = 205 / 45
    expect(bayes(5, 4.2, [...Array(24).fill(5), ...Array(16).fill(4)])).toBeCloseTo(205 / 45, 12);
    // (5 · 3 + 2 + 4) / 7 = 3
    expect(bayes(5, 3, [2, 4])).toBe(3);
    // c = 0 is the plain mean
    expect(bayes(0, 4, [1, 2, 3])).toBe(2);
  });

  it('gives m for no ratings', () => {
    expect(bayes(5, 4.2, [])).toBe(4.2);
    expect(bayes(5, 0, [])).toBe(0);
  });

  it('owner caveat Q3: once m > 4.5 a single 5 outranks a 4.6 average', () => {
    const m = 4.6;
    const single = bayes(BAYES_C, m, [5]);
    const forty = bayes(BAYES_C, m, [...Array(24).fill(5), ...Array(16).fill(4)]); // mean 4.6 over 40
    expect(single).toBeGreaterThan(forty);
    // below 4.5 the many ratings win (the case the ranking test pins in SQL)
    expect(bayes(BAYES_C, 4.2, [5])).toBeLessThan(bayes(BAYES_C, 4.2, [...Array(24).fill(5), ...Array(16).fill(4)]));
  });

  it('always lies between m and the plain mean (criterion 4, fast-check)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 500 }),
        (m, ratings) => {
          const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          const score = bayes(BAYES_C, m, ratings);
          const eps = 1e-12;
          expect(score).toBeGreaterThanOrEqual(Math.min(m, mean) - eps);
          expect(score).toBeLessThanOrEqual(Math.max(m, mean) + eps);
        },
      ),
    );
  });
});
