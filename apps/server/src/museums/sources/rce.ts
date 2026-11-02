// The RCE source (plan §2.2): "Musea in Nederland", WFS layer `overzichtmusea`, Public Domain Mark.
// Everything marked [U] is a guess until the owner's recording (O1) settles it; each guess
// sits in one named constant or in RCE_PROPS, so the correction is one edit.

import { z } from 'zod';
import { LIMITS, NL_BOX } from '../fields.ts';
import { type FetchJsonResult, fetchJson, type HttpDeps } from './http.ts';
import { RCE_ID, rcePayload } from './payload.ts';
import { cleanText, postcode } from './text.ts';
import type { ParseResult, RceRow } from './types.ts';

/** [U] The service path (the research names Veiligheid_van_Erfgoed). */
export const RCE_WFS_URL = 'https://services.rce.geovoorziening.nl/Veiligheid_van_Erfgoed/wfs';
/**
 * The feature type, with its namespace prefix: the name data.overheid.nl lists for "Musea in
 * Nederland" (dataset 44332). `rce:overzichtmusea` failed with http_status (O1, 2026-11-02).
 */
export const RCE_TYPE_NAME = 'Veiligheid_van_Erfgoed:overzichtmusea';
/** [U] GeoServer answers `application/json` (GeoJSON) for WFS 2.0. */
export const RCE_OUTPUT_FORMAT = 'application/json';
/** [U] Longitude/latitude in EPSG:4326; the axis order of the answer is detected by the parser. */
export const RCE_SRS_NAME = 'EPSG:4326';

/** The one GetFeature URL for all rows. */
export function rceUrl(): string {
  const url = new URL(RCE_WFS_URL);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', RCE_TYPE_NAME);
  url.searchParams.set('outputFormat', RCE_OUTPUT_FORMAT);
  url.searchParams.set('srsName', RCE_SRS_NAME);
  return url.href;
}

export function fetchRce(deps: HttpDeps = {}): Promise<FetchJsonResult> {
  return fetchJson(rceUrl(), { method: 'GET', headers: { Accept: RCE_OUTPUT_FORMAT } }, deps);
}

/**
 * Property names of a feature, as the owner's recording shows them (O1, 2026-11-02, 629 features).
 * There is no id property: the feature's own `id` (GeoServer: `overzichtmusea.12`) is the key [U
 * stable when RCE reloads the dataset]. `Adres` is the street alone; the number is `Huisnummer` plus
 * the addition `HnrToev` (a letter, `HS` or a number).
 */
export const RCE_PROPS = {
  name: 'Museum',
  street: 'Adres',
  houseNumber: 'Huisnummer',
  houseNumberAddition: 'HnrToev',
  postcode: 'Pc6',
  place: 'Woonplaats',
  municipality: 'Gemeente',
} as const;

const Collection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function bump(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function plain(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => byCodeUnit(a, b)));
}

/** A string, or a whole number written as a number (a house number may be numeric). */
function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return undefined;
}

/** A property as cleaned text: null when absent or empty, undefined (and a note) when over its cap. */
function field(props: Record<string, unknown>, key: string, max: number, tooLong: string, notes: Set<string>) {
  const raw = textOf(props[key]);
  if (raw === undefined) return null;
  const r = cleanText(raw, max);
  if (r.ok) return r.value;
  if (r.code === 'too_long') notes.add(tooLong);
  return null;
}

/** `Huisnummer` with its addition: a single letter joins directly (8A), anything else after a dash (12-1, 7-HS). */
function houseNumberOf(props: Record<string, unknown>, notes: Set<string>): string | null {
  const number = field(props, RCE_PROPS.houseNumber, LIMITS.houseNumber, 'house_number_too_long', notes);
  if (number === null) return null;
  const addition = field(props, RCE_PROPS.houseNumberAddition, LIMITS.houseNumber, 'house_number_too_long', notes);
  if (addition === null) return number;
  const joined = /^[A-Za-z]$/.test(addition) ? `${number}${addition}` : `${number}-${addition}`;
  if (joined.length > LIMITS.houseNumber) {
    notes.add('house_number_too_long');
    return number;
  }
  return joined;
}

const between = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

/**
 * GeoJSON puts longitude first, but a WFS 2.0 answer in EPSG:4326 may put latitude
 * first. The NL latitude (50.7-53.7) and longitude (3.2-7.3) ranges do not overlap,
 * so a swapped pair is unambiguous.
 */
function coordinates(geometry: unknown, notes: Set<string>): { lat: number; lon: number } | null {
  if (geometry === null || geometry === undefined) return null;
  if (!isRecord(geometry) || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
    notes.add('coord_unparsed');
    return null;
  }
  const [x, y] = geometry.coordinates as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    notes.add('coord_unparsed');
    return null;
  }
  let lat = y;
  let lon = x;
  if (between(x, NL_BOX.latMin, NL_BOX.latMax) && between(y, NL_BOX.lonMin, NL_BOX.lonMax)) {
    lat = x;
    lon = y;
    notes.add('coord_swapped');
  }
  if (!between(lat, NL_BOX.latMin, NL_BOX.latMax) || !between(lon, NL_BOX.lonMin, NL_BOX.lonMax)) {
    // Also RD New (metres) and anything else that is not WGS 84 in the Netherlands.
    notes.delete('coord_swapped');
    notes.add('coord_outside_nl');
    return null;
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

type Built = { row: RceRow } | { invalid: string };

function build(feature: unknown, notes: Set<string>): Built {
  if (!isRecord(feature) || !isRecord(feature.properties)) return { invalid: 'bad_feature' };
  const props = feature.properties;

  const rawId = textOf(feature.id);
  if (rawId === undefined) return { invalid: 'no_id' };
  const id = cleanText(rawId, LIMITS.rceId);
  if (!id.ok) return { invalid: id.code === 'empty' ? 'no_id' : 'id_too_long' };
  // The key is stored as `museum.rce_id` and `museum_source_row.external_id`, and named in `admin match resolve rce:<id>`.
  if (!RCE_ID.test(id.value)) return { invalid: 'bad_id' };

  const rawName = props[RCE_PROPS.name];
  if (typeof rawName !== 'string') return { invalid: 'no_name' };
  const name = cleanText(rawName, LIMITS.label);
  if (!name.ok) return { invalid: name.code === 'empty' ? 'no_name' : 'name_too_long' };

  let pc: string | null = null;
  const rawPostcode = textOf(props[RCE_PROPS.postcode]);
  if (rawPostcode !== undefined && rawPostcode.trim() !== '') {
    pc = postcode(rawPostcode) ?? null;
    if (pc === null) notes.add('postcode_invalid');
  }
  const point = coordinates(feature.geometry, notes);

  return {
    row: {
      rceId: id.value,
      name: name.value,
      street: field(props, RCE_PROPS.street, LIMITS.street, 'street_too_long', notes),
      houseNumber: houseNumberOf(props, notes),
      postcode: pc,
      place: field(props, RCE_PROPS.place, LIMITS.place, 'place_too_long', notes),
      municipalityName: field(props, RCE_PROPS.municipality, LIMITS.municipalityName, 'municipality_too_long', notes),
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
    },
  };
}

/** Parses a WFS GeoJSON FeatureCollection into rows sorted by `rceId`, each one fitting the columns. Never throws. */
export function parseRce(json: unknown): ParseResult<RceRow> {
  try {
    const collection = Collection.safeParse(json);
    if (!collection.success) return { ok: false, code: 'schema' };

    const invalid = new Map<string, number>();
    const notes = new Map<string, number>();
    const seen = new Set<string>();
    const rows: RceRow[] = [];
    for (const feature of collection.data.features) {
      const featureNotes = new Set<string>();
      const built = build(feature, featureNotes);
      if ('invalid' in built) {
        bump(invalid, built.invalid);
        continue;
      }
      // The column shapes, checked once more: a row the database would refuse is dropped here, not in the run.
      if (!rcePayload.safeParse(built.row).success) {
        bump(invalid, 'bad_payload');
        continue;
      }
      if (seen.has(built.row.rceId)) {
        bump(invalid, 'duplicate_id');
        continue;
      }
      seen.add(built.row.rceId);
      rows.push(built.row);
      for (const code of featureNotes) bump(notes, code);
    }
    rows.sort((a, b) => byCodeUnit(a.rceId, b.rceId));
    return { ok: true, rows, invalid: plain(invalid), notes: plain(notes) };
  } catch {
    return { ok: false, code: 'schema' };
  }
}
