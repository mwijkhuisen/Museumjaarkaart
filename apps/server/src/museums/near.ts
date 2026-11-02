import type { NearItem } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { NL_BOX } from './fields.ts';
import { EARTH_RADIUS_M } from './geo.ts';

// Near-me (A§14, ADR-0015, owner decision Q4): the k nearest visible museums to a point, with no
// radius cap. Reads only pub_museum, so it works as mjk_api and as mjk_ssr. The caller parsed the
// point with NearQuery, so every value reaches SQL as a bound number, never as text to cast (the
// 22P02 gotcha). The point is positional data of a visitor: nothing here logs.

/** geo.ts's radius, so the box and the haversine distance agree (a test checks them against each other). */
export { EARTH_RADIUS_M };

/** The first search radius in metres; it doubles until the answer is proven. */
export const START_RADIUS_M = 2_000;

/** Widening of the box, in degrees: absorbs floating-point rounding, and only ever makes it safe. */
const MARGIN_DEG = 1e-9;

export type Box = { latMin: number; latMax: number; lonMin: number; lonMax: number };

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * A box around (lat, lon) that holds the whole disk of radius `radiusM` metres on the sphere.
 *
 * A point at angular distance at most d = r / R from the centre has a latitude within d of the
 * centre's, so dLat = degrees(d). Its longitude differs from the centre's by at most
 * asin(sin d / cos lat): the meridian that touches the circle of radius d is the extreme one.
 * That holds while d < 90° and sin d < cos lat; otherwise the disk reaches a pole or covers a
 * hemisphere, and the box spans every longitude. The box may cross ±180 or ±90: never in NL.
 */
export function boundingBox(lat: number, lon: number, radiusM: number): Box {
  const d = radiusM / EARTH_RADIUS_M;
  const dLat = deg(d) + MARGIN_DEG;
  const ratio = d >= Math.PI / 2 ? 1 : Math.sin(d) / Math.cos(rad(lat));
  const dLon = ratio >= 1 ? 180 : deg(Math.asin(ratio)) + MARGIN_DEG;
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon };
}

/** True when the box holds all of the European NL box: no museum (the CHECK keeps them inside it) is outside. */
export function coversNlBox(b: Box): boolean {
  return (
    b.latMin <= NL_BOX.latMin && b.latMax >= NL_BOX.latMax && b.lonMin <= NL_BOX.lonMin && b.lonMax >= NL_BOX.lonMax
  );
}

export type NearResult = {
  items: NearItem[];
  /** How many box queries ran (1 when the first radius sufficed). */
  rounds: number;
};

/**
 * The `limit` nearest visible museums with coordinates that are not permanently closed
 * (`closed_on` empty or in the future: a temporary closure stays in, the item carries its flags),
 * ordered by distance and then id, each with its distance rounded to whole metres.
 *
 * The search runs in one REPEATABLE READ, READ ONLY transaction (every round sees the same
 * snapshot), starting at r = 2,000 m:
 *
 *   1. Read the museums inside the box of `boundingBox(lat, lon, r)` (an index range scan on
 *      museum_lat_lon_idx), compute their haversine distance in SQL, order by (distance, id) and
 *      keep `limit` rows.
 *   2. Every museum outside the box lies outside the disk of radius r, so it is farther than r.
 *      If `limit` rows came back and the last one is at most r away, no museum outside the box can
 *      beat or tie it, so the rows are the global k nearest. Stop.
 *   3. If the box already holds all of NL_BOX, every museum is inside it, so the rows are global
 *      even with fewer than `limit` of them. Stop.
 *   4. Otherwise double r and go again. r doubles from 2 km, so a box over all of NL (about
 *      450 km across) is reached after 8 doublings at most.
 */
export async function findNearest(db: Db, q: { lat: number; lon: number; limit: number }): Promise<NearResult> {
  const { lat, lon, limit } = q;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      // The formula of geo.ts's haversineMetres, in double precision.
      const distance = sql<number>`2 * ${EARTH_RADIUS_M}::float8 * asin(sqrt(least(1,
        sin(radians(m.lat - ${lat}::float8) / 2) ^ 2
        + cos(radians(${lat}::float8)) * cos(radians(m.lat)) * sin(radians(m.lon - ${lon}::float8) / 2) ^ 2)))`;
      let radius = START_RADIUS_M;
      for (let rounds = 1; ; rounds++) {
        const box = boundingBox(lat, lon, radius);
        const rows = await trx
          .selectFrom('pub_museum as m')
          .select([
            'm.id',
            'm.slug',
            'm.name',
            'm.name_en',
            'm.place',
            'm.municipality_code',
            'm.municipality_name',
            'm.province_code',
            'm.lat',
            'm.lon',
            'm.categories',
            'm.museumkaart_status',
            'm.registered',
            'm.closed_on',
            'm.temp_closed',
            distance.as('distance'),
          ])
          .where('m.lat', 'is not', null)
          .where('m.lat', '>=', box.latMin)
          .where('m.lat', '<=', box.latMax)
          .where('m.lon', '>=', box.lonMin)
          .where('m.lon', '<=', box.lonMax)
          .where((eb) => eb.or([eb('m.closed_on', 'is', null), eb('m.closed_on', '>', sql<string>`current_date`)]))
          .orderBy('distance')
          .orderBy('m.id')
          .limit(limit)
          .execute();
        const last = rows[limit - 1];
        const proven = last !== undefined && last.distance <= radius;
        if (proven || coversNlBox(box)) {
          return {
            rounds,
            items: rows.map((r) => ({
              id: r.id as string,
              slug: r.slug as string,
              name: r.name as string,
              name_en: r.name_en,
              place: r.place,
              municipality_code: r.municipality_code,
              municipality_name: r.municipality_name,
              province_code: r.province_code as NearItem['province_code'],
              lat: r.lat as number,
              lon: r.lon as number,
              categories: (r.categories ?? []) as NearItem['categories'],
              museumkaart_status: r.museumkaart_status as NearItem['museumkaart_status'],
              registered: r.registered === true,
              closed_on: r.closed_on,
              temp_closed: r.temp_closed === true,
              distance_m: Math.round(r.distance),
            })),
          };
        }
        radius *= 2;
      }
    });
}
