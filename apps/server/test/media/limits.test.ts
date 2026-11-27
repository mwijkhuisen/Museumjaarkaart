import { describe, expect, it } from 'vitest';
import { variantWidths } from '../../src/media/limits.ts';
import { variantKey } from '../../src/media/types.ts';

describe('variantWidths', () => {
  it('never upscales and keeps the source width when no planned width equals it', () => {
    expect(variantWidths(300)).toEqual([300]);
    expect(variantWidths(400)).toEqual([400]);
    expect(variantWidths(1000)).toEqual([400, 1000]);
    expect(variantWidths(1200)).toEqual([400, 1200]);
    expect(variantWidths(1500)).toEqual([400, 1200, 1500]);
    expect(variantWidths(2000)).toEqual([400, 1200, 2000]);
    expect(variantWidths(6000)).toEqual([400, 1200, 2000]);
  });

  it('refuses a width that is not a positive integer', () => {
    for (const w of [0, -1, 1.5, Number.NaN]) expect(() => variantWidths(w)).toThrow();
  });
});

describe('variantKey', () => {
  const key = 'a'.repeat(32);

  it('is p/<random>/<width>.<ext>', () => {
    expect(variantKey(key, 'avif', 400)).toBe(`p/${key}/400.avif`);
    expect(variantKey(key, 'webp', 2000)).toBe(`p/${key}/2000.webp`);
  });

  it('refuses anything but 32 hex characters and a sane width', () => {
    expect(() => variantKey('A'.repeat(32), 'avif', 400)).toThrow();
    expect(() => variantKey(`${key}/..`, 'avif', 400)).toThrow();
    expect(() => variantKey(key, 'avif', 0)).toThrow();
  });
});
