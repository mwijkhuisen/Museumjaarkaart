import { NL_BOX } from './fields.ts';

export type LatLon = { lat: number; lon: number };

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. NaN in, NaN out. */
export function haversineMetres(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  // Rounding can push h a hair past 1 for antipodes; asin would then return NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Inside the box of the European Netherlands (the `museum` CHECK uses the same one). */
export function inNlBox(lat: number, lon: number): boolean {
  return lat >= NL_BOX.latMin && lat <= NL_BOX.latMax && lon >= NL_BOX.lonMin && lon <= NL_BOX.lonMax;
}
