import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NL_BOX } from '../../src/museums/fields.ts';
import { haversineMetres } from '../../src/museums/geo.ts';
import { boundingBox, coversNlBox, EARTH_RADIUS_M, START_RADIUS_M } from '../../src/museums/near.ts';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point at `metres` from (lat, lon) along `bearing` (radians) on the sphere of haversineMetres. */
function destination(lat: number, lon: number, bearing: number, metres: number) {
  const d = metres / EARTH_RADIUS_M;
  const phi = rad(lat);
  const lat2 = Math.asin(Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(bearing));
  const dLon = Math.atan2(
    Math.sin(bearing) * Math.sin(d) * Math.cos(phi),
    Math.cos(d) - Math.sin(phi) * Math.sin(lat2),
  );
  return { lat: deg(lat2), lon: lon + deg(dLon) };
}

const centre = fc.record({
  lat: fc.double({ min: NL_BOX.latMin, max: NL_BOX.latMax, noNaN: true }),
  lon: fc.double({ min: NL_BOX.lonMin, max: NL_BOX.lonMax, noNaN: true }),
});
const radius = fc.double({ min: 100, max: 500_000, noNaN: true });
const bearing = fc.double({ min: 0, max: 2 * Math.PI, noNaN: true });

describe('the sphere of near.ts', () => {
  it('uses the radius of haversineMetres', () => {
    // Half a great circle is pi * R.
    const half = haversineMetres({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(half / Math.PI).toBeCloseTo(EARTH_RADIUS_M, 6);
  });
});

describe('boundingBox', () => {
  it('holds every point within r of the centre (random centres, 100 m to 500 km, random bearings)', () => {
    fc.assert(
      fc.property(centre, radius, bearing, fc.double({ min: 0, max: 1, noNaN: true }), (c, r, b, share) => {
        const box = boundingBox(c.lat, c.lon, r);
        // On the circle itself, and strictly inside it.
        for (const metres of [r, r * share]) {
          const p = destination(c.lat, c.lon, b, metres);
          expect(haversineMetres(c, p)).toBeLessThanOrEqual(r * (1 + 1e-9));
          expect(p.lat).toBeGreaterThanOrEqual(box.latMin);
          expect(p.lat).toBeLessThanOrEqual(box.latMax);
          expect(p.lon).toBeGreaterThanOrEqual(box.lonMin);
          expect(p.lon).toBeLessThanOrEqual(box.lonMax);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('is tight where it matters: the north, south, east and west extremes touch the box within a metre', () => {
    fc.assert(
      fc.property(centre, radius, (c, r) => {
        const box = boundingBox(c.lat, c.lon, r);
        const north = destination(c.lat, c.lon, 0, r);
        expect(Math.abs(north.lat - box.latMax)).toBeLessThan(1e-5);
        // The extreme longitude is reached on the tangent meridian, which is not due east.
        const dLon = deg(Math.asin(Math.sin(r / EARTH_RADIUS_M) / Math.cos(rad(c.lat))));
        expect(box.lonMax - c.lon).toBeCloseTo(dLon, 6);
        expect(c.lon - box.lonMin).toBeCloseTo(dLon, 6);
        expect(c.lat - box.latMin).toBeCloseTo(deg(r / EARTH_RADIUS_M), 6);
      }),
    );
  });

  it('spans every longitude when the disk reaches a pole or a hemisphere', () => {
    expect(boundingBox(89.9, 5, 50_000)).toMatchObject({ lonMin: -175, lonMax: 185 });
    expect(boundingBox(52, 5, 11_000_000)).toMatchObject({ lonMin: -175, lonMax: 185 });
  });

  it('covers NL_BOX from every centre inside it once r is 500 km, and not at the first radius', () => {
    fc.assert(
      fc.property(centre, (c) => {
        expect(coversNlBox(boundingBox(c.lat, c.lon, 500_000))).toBe(true);
        expect(coversNlBox(boundingBox(c.lat, c.lon, START_RADIUS_M))).toBe(false);
      }),
    );
    for (const lat of [NL_BOX.latMin, NL_BOX.latMax])
      for (const lon of [NL_BOX.lonMin, NL_BOX.lonMax]) expect(coversNlBox(boundingBox(lat, lon, 500_000))).toBe(true);
  });

  it('doubling from 2 km covers NL_BOX within 9 rounds from any centre inside it', () => {
    const corners = [NL_BOX.latMin, NL_BOX.latMax].flatMap((lat) =>
      [NL_BOX.lonMin, NL_BOX.lonMax].map((lon) => ({ lat, lon })),
    );
    for (const c of corners) {
      let r = START_RADIUS_M;
      let rounds = 1;
      while (!coversNlBox(boundingBox(c.lat, c.lon, r))) {
        r *= 2;
        rounds++;
      }
      expect(rounds).toBeLessThanOrEqual(9);
    }
  });
});
