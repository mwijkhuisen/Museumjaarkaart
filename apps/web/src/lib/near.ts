// Near me (A§15.3): the browser's position is rounded here, before anything leaves the page.

/**
 * The position as the two query values of `GET /museums/near`: at most 3 decimals (about 100 m),
 * which is also all the API's `NearQuery` accepts. "-0.000" becomes "0.000". Throws a RangeError
 * on a value that is not a finite coordinate, so garbage never reaches a request.
 */
export function roundPosition(lat: number, lon: number): { lat: string; lon: string } {
  const round = (n: number, limit: number) => {
    if (!Number.isFinite(n) || Math.abs(n) > limit) throw new RangeError('not_a_coordinate');
    const s = n.toFixed(3);
    return s === '-0.000' ? '0.000' : s;
  };
  return { lat: round(lat, 90), lon: round(lon, 180) };
}
