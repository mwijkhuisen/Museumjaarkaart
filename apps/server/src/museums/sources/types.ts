// Shared contract of the source clients and parsers (WP2), the fixtures (WP3)
// and the sync (WP5). A parser never throws: it returns a ParseResult.
// Every string here is already normalised (NFC, collapsed whitespace, no C0/C1
// controls or bidi overrides) and within its length cap (invariant 5).

import type { Source } from '../fields.ts';

export type { Source };

/** Fixed codes for a source that cannot be used at all (the run applies nothing). */
export const SOURCE_ERROR_CODES = [
  'host_not_allowed',
  'redirect',
  'timeout',
  'network',
  'too_large',
  'http_status',
  'rate_limited',
  'not_json',
  'schema',
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

/**
 * `invalid`: rows dropped, counted per fixed code (e.g. `bad_qid`, `no_label`, `label_too_long`).
 * `notes`: rows kept with one field dropped or derived, counted per fixed code
 * (e.g. `coord_outside_nl`, `website_upgraded`, `website_not_https`, `museumnl_bad_host`, `address_parsed`, `address_unparsed`).
 */
export type ParseResult<T> =
  | { ok: true; rows: T[]; invalid: Record<string, number>; notes: Record<string, number> }
  | { ok: false; code: SourceErrorCode };

/** One Wikidata item (a museum in the European Netherlands), reduced deterministically. */
export type WikidataRow = {
  /** `Q123`. */
  qid: string;
  /** The nl label, else the en label (a row without either is invalid: `no_label`). */
  name: string;
  nameEn: string | null;
  descriptionNl: string | null;
  descriptionEn: string | null;
  /** nl and en aliases, unique, sorted; the name itself excluded. */
  aliases: string[];
  /** P625, inside the European-NL box, or both null. */
  lat: number | null;
  lon: number | null;
  /** P856, https only. */
  website: string | null;
  /** From P6375 (parsed) and P281. */
  street: string | null;
  houseNumber: string | null;
  /** `1234 AB`. */
  postcode: string | null;
  place: string | null;
  /** The municipality's CBS code (P382) as `GM0363`, its label and its province (P300, `NL-NH`). */
  municipalityCode: string | null;
  municipalityName: string | null;
  provinceCode: string | null;
  /** P166 = Q110989587 ("Geregistreerd museum"). */
  registered: boolean;
  /** P973 on the host www.museum.nl only (a link-out hint, never fetched). */
  museumnlUrl: string | null;
  /** P18: the Commons file name without `File:` (P1a stores it only). */
  commonsFile: string | null;
  /** P31 classes, unique, sorted (the sync maps them to categories, museums/categories.ts). */
  classes: string[];
  /** P576 as `YYYY-MM-DD`. */
  dissolvedOn: string | null;
};

/** One RCE "Musea in Nederland" feature (WFS `overzichtmusea`). */
export type RceRow = {
  rceId: string;
  name: string;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  place: string | null;
  municipalityName: string | null;
  lat: number | null;
  lon: number | null;
};

export type SourceRow = { source: 'wikidata'; row: WikidataRow } | { source: 'rce'; row: RceRow };
