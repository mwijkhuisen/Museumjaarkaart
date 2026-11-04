import { describe, expect, it } from 'vitest';
import { haversineMetres, inNlBox } from '../../src/museums/geo.ts';

const R = 6_371_008.8;

/** A point `metres` due north of `p`. */
const north = (p: { lat: number; lon: number }, metres: number) => ({
  lat: p.lat + ((metres / R) * 180) / Math.PI,
  lon: p.lon,
});
/** A point `metres` due east of `p` (along its parallel). */
const east = (p: { lat: number; lon: number }, metres: number) => ({
  lat: p.lat,
  lon: p.lon + ((metres / (R * Math.cos((p.lat * Math.PI) / 180))) * 180) / Math.PI,
});

const AMSTERDAM = { lat: 52.3731, lon: 4.8922 };

describe('haversineMetres', () => {
  it('is 0 for the same point and symmetric', () => {
    expect(haversineMetres(AMSTERDAM, AMSTERDAM)).toBe(0);
    const rotterdam = { lat: 51.9244, lon: 4.4777 };
    expect(haversineMetres(AMSTERDAM, rotterdam)).toBe(haversineMetres(rotterdam, AMSTERDAM));
  });

  it('0.001 degree of latitude is about 111.2 m', () => {
    const d = haversineMetres({ lat: 52, lon: 5 }, { lat: 52.001, lon: 5 });
    expect(d).toBeCloseTo(111.195, 2);
    expect(Math.abs(d - 111.2)).toBeLessThan(0.1);
  });

  it('0.001 degree of longitude at 52 N is about 68.5 m', () => {
    expect(haversineMetres({ lat: 52, lon: 5 }, { lat: 52, lon: 5.001 })).toBeCloseTo(68.46, 1);
  });

  it('Amsterdam to Rotterdam is about 57 km', () => {
    const d = haversineMetres(AMSTERDAM, { lat: 51.9244, lon: 4.4777 });
    expect(d).toBeGreaterThan(56_000);
    expect(d).toBeLessThan(58_500);
  });

  it('constructed points land on either side of the 150 m rule', () => {
    expect(haversineMetres(AMSTERDAM, north(AMSTERDAM, 149))).toBeLessThan(150);
    expect(haversineMetres(AMSTERDAM, north(AMSTERDAM, 151))).toBeGreaterThan(150);
    expect(haversineMetres(AMSTERDAM, east(AMSTERDAM, 149))).toBeLessThan(150);
    expect(haversineMetres(AMSTERDAM, east(AMSTERDAM, 151))).toBeGreaterThan(150);
    expect(haversineMetres(AMSTERDAM, north(AMSTERDAM, 149))).toBeCloseTo(149, 6);
  });

  it('antipodes do not give NaN', () => {
    expect(haversineMetres({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(Math.PI * R, 0);
  });

  it('NaN in, NaN out', () => {
    expect(haversineMetres({ lat: Number.NaN, lon: 0 }, AMSTERDAM)).toBeNaN();
  });
});

describe('inNlBox', () => {
  it('accepts points inside, edges included', () => {
    expect(inNlBox(52.37, 4.89)).toBe(true);
    expect(inNlBox(50.7, 3.2)).toBe(true);
    expect(inNlBox(53.7, 7.3)).toBe(true);
  });

  it('rejects points outside and swapped axes', () => {
    expect(inNlBox(4.89, 52.37)).toBe(false);
    expect(inNlBox(50.69, 5)).toBe(false);
    expect(inNlBox(53.71, 5)).toBe(false);
    expect(inNlBox(52, 3.19)).toBe(false);
    expect(inNlBox(52, 7.31)).toBe(false);
    expect(inNlBox(Number.NaN, 5)).toBe(false);
  });
});
