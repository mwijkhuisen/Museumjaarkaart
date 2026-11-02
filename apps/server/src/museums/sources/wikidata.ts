// The Wikidata source (plan §2.2): the query, its one POST and the parser.
// Wikidata text is untrusted (invariant 5): every string passes cleanText, every
// URL is checked, and a P18 URL is reduced to a file name and never kept.
// parseWikidata never throws; a problem becomes a fixed code in `invalid` or `notes`. Every row it
// returns fits the database's columns (sources/payload.ts), or it is invalid `bad_payload`.

import { createHash } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { z } from 'zod';
import { CBS_CODE, LIMITS, NL_BOX, PROVINCE_CODE, QID } from '../fields.ts';
import { museumnlUrl } from '../museumnl.ts';
import { type FetchJsonResult, fetchJson, type HttpDeps } from './http.ts';
import { wikidataPayload } from './payload.ts';
import { cleanText, codePointLength, hasInvisible, postcode } from './text.ts';
import type { ParseResult, WikidataRow } from './types.ts';
import { WIKIDATA_QUERY } from './wikidata-query.ts';

export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
/** Separates the values of a GROUP_CONCAT (a C0 control: cleanText would remove it, so it cannot occur in a value we keep). */
export const RECORD_SEP = '\u001F';
/** Separates the fields of the municipality record (code, name, province). */
export const FIELD_SEP = '\u001E';

const VALUES_MARKER = /^[ \t]*# @@MJK_VALUES@@[ \t]*$/m;
/** A restricted recording stays a small list; the full run has no list at all. */
const MAX_QIDS = 500;

/**
 * The query exactly as committed (its sha256 is pinned by the fixtures' meta files). It is a module
 * constant, not a file read at run time, so it is part of the emitted `dist`; `wikidata.sparql` is the
 * same text for reading and for the runbook's curl (a unit test keeps them identical).
 */
export function wikidataQueryText(): string {
  return WIKIDATA_QUERY;
}

export function wikidataQuerySha256(): string {
  return createHash('sha256').update(wikidataQueryText()).digest('hex');
}

/**
 * The query, optionally restricted to some items for a recording. A bad QID is a
 * programmer or CLI error (not source data), so it throws; the message holds no input.
 */
export function wikidataQuery(opts: { qids?: readonly string[] } = {}): string {
  const text = wikidataQueryText();
  if (opts.qids === undefined) return text;
  if (opts.qids.length > MAX_QIDS) throw new Error('wikidata_query_usage: too many qids');
  for (const qid of opts.qids) {
    if (typeof qid !== 'string' || !QID.test(qid)) throw new Error('wikidata_query_usage: bad qid');
  }
  if (!VALUES_MARKER.test(text)) throw new Error('wikidata_query_usage: marker missing');
  return text.replace(VALUES_MARKER, `  VALUES ?item { ${opts.qids.map((q) => `wd:${q}`).join(' ')} }`);
}

/**
 * The item list: the query's own item set (its WITH block, with the Caribbean filter) and nothing per
 * item, for the batched fetch. Derived from WIKIDATA_QUERY, so the two always select the same items.
 */
export function wikidataItemsQuery(): string {
  const text = wikidataQueryText();
  const open = '\nWITH {\n';
  const start = text.indexOf(open);
  const end = text.indexOf('\n} AS %items');
  const select = '  SELECT DISTINCT ?item WHERE {';
  if (start < 0 || end < start || !text.includes(select)) throw new Error('wikidata_query_usage: no item set');
  const prefixes = text
    .split('\n')
    .filter((l) => l.startsWith('PREFIX '))
    .join('\n');
  const body = text
    .slice(start + open.length, end)
    .replace(VALUES_MARKER, '')
    .replace(select, `${select}\n    hint:Query hint:optimizer "None" .`);
  return `${prefixes}\n\n${body}\n`;
}

/** Museums per detail request: far under WDQS's 60 s (three items took 1.4 s, all 1,430 timed out). */
export const WIKIDATA_BATCH = 200;
/** The pause before each detail request, so the run stays well inside WDQS's per-client query budget. */
export const WIKIDATA_PAUSE_MS = 2_000;

/** The QIDs of an item-list answer, unique and in QID order; undefined for a malformed answer. */
export function itemsOf(json: unknown): string[] | undefined {
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return undefined;
  const qids = new Set<string>();
  for (const b of envelope.data.results.bindings) {
    if (!isRecord(b) || !isRecord(b.item) || typeof b.item.value !== 'string') continue;
    const qid = qidOf(b.item.value);
    if (qid !== undefined) qids.add(qid);
  }
  return [...qids].sort(byQid);
}

/**
 * The sync's Wikidata fetch (A§7.1): the item list, then the details in batches of WIKIDATA_BATCH with
 * the restricted query (the same text and sha256 the fixtures pin), one request at a time. The answers
 * merge into one `application/sparql-results+json` body, so the parser and the guards see one answer.
 * Any failed request fails the fetch with its code; a malformed answer is returned as it is, for the
 * parser to report as `schema`. `ms` and `bytes` add up the requests (the pauses are not counted).
 */
export async function fetchWikidataAll(deps: HttpDeps = {}): Promise<FetchJsonResult> {
  const sleep = deps.sleep ?? ((ms: number) => sleepFor(ms));
  const list = await fetchWikidata(wikidataItemsQuery(), deps);
  if (!list.ok) return list;
  const qids = itemsOf(list.body);
  if (qids === undefined) return list;
  let ms = list.ms;
  let bytes = list.bytes;
  let head: unknown = { vars: ['item'] };
  const bindings: unknown[] = [];
  for (let i = 0; i < qids.length; i += WIKIDATA_BATCH) {
    await sleep(WIKIDATA_PAUSE_MS);
    const part = await fetchWikidata(wikidataQuery({ qids: qids.slice(i, i + WIKIDATA_BATCH) }), deps);
    if (!part.ok) return part;
    const envelope = Envelope.safeParse(part.body);
    if (!envelope.success) return part;
    ms += part.ms;
    bytes += part.bytes;
    head = envelope.data.head;
    bindings.push(...envelope.data.results.bindings);
  }
  return { ok: true, body: { head, results: { bindings } }, ms, bytes };
}

/** One POST (a descriptive User-Agent comes from the HTTP helper). The sync calls fetchWikidataAll. */
export function fetchWikidata(query: string, deps: HttpDeps = {}): Promise<FetchJsonResult> {
  return fetchJson(
    WIKIDATA_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: new URLSearchParams({ query }).toString(),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Parser

const Envelope = z.object({
  head: z.object({ vars: z.array(z.string()) }),
  results: z.object({ bindings: z.array(z.unknown()) }),
});

const Cell = z.object({
  type: z.string(),
  value: z.string(),
  'xml:lang': z.string().optional(),
  datatype: z.string().optional(),
});

/** Variables that hold one value (never split: a label may hold any character). */
const SINGLE_VARS = ['labelNl', 'labelEn', 'descNl', 'descEn', 'registered'] as const;
/**
 * Variables that hold a GROUP_CONCAT of values. The query COALESCEs each to "" (an aggregate
 * over UNION rows must not fail), so an empty record is normal and is dropped.
 */
const MULTI_VARS = [
  'aliases',
  'coords',
  'websites',
  'addresses',
  'postcodes',
  'municipalities',
  'museumnl',
  'images',
  'classes',
  'dissolved',
] as const;
type Var = (typeof SINGLE_VARS)[number] | (typeof MULTI_VARS)[number];

const ENTITY_PREFIX = /^https?:\/\/www\.wikidata\.org\/entity\//;
const MAX_VALUES = 500;
const MAX_ALIASES = 50;
const MAX_CLASSES = 50;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function qidOf(uri: string): string | undefined {
  const bare = uri.replace(ENTITY_PREFIX, '');
  return QID.test(bare) ? bare : undefined;
}

function bump(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function plain(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => byCodeUnit(a, b)));
}

/** Everything one item collected over its binding rows: distinct raw values per variable. */
type Collected = Map<Var, Set<string>>;

function sorted(collected: Collected, name: Var): string[] {
  return [...(collected.get(name) ?? [])].sort(byCodeUnit).slice(0, MAX_VALUES);
}

type Label = { value: string | null; tooLong: boolean };

function firstText(values: readonly string[], max: number): Label {
  for (const v of values) {
    const r = cleanText(v, max);
    if (r.ok) return { value: r.value, tooLong: false };
    if (r.code === 'too_long') return { value: null, tooLong: true };
  }
  return { value: null, tooLong: false };
}

const POINT =
  /^Point\(\s*(-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)\s+(-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)\s*\)$/;

/** WKT `Point(lon lat)` to a coordinate pair in the NL box. */
function parsePoint(wkt: string): { lat: number; lon: number } | 'coord_unparsed' | 'coord_outside_nl' {
  const m = POINT.exec(wkt.trim());
  if (!m) return 'coord_unparsed';
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'coord_unparsed';
  if (lat < NL_BOX.latMin || lat > NL_BOX.latMax || lon < NL_BOX.lonMin || lon > NL_BOX.lonMax) {
    return 'coord_outside_nl';
  }
  // Six decimals are about 0.1 m: a stable number for the golden files and the diff.
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

function isCleanToken(v: string): boolean {
  return !/\s/u.test(v) && !hasInvisible(v);
}

/**
 * An https URL without credentials, at most 2,048 characters, or the note that explains why not.
 * An http URL is upgraded to https (owner, 2026-11-02): about half of the recorded P856 values are
 * http only. We link and never fetch, so a site without https is a broken link the owner can pin over.
 */
function httpsUrl(v: string): { url: string; upgraded: boolean } | { note: 'website_not_https' | 'website_invalid' } {
  if (!isCleanToken(v) || v.length > LIMITS.url) return { note: 'website_invalid' };
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { note: 'website_invalid' };
  }
  const upgraded = url.protocol === 'http:';
  if (upgraded) url.protocol = 'https:';
  if (url.protocol !== 'https:') return { note: 'website_not_https' };
  if (url.username !== '' || url.password !== '' || url.hostname === '' || url.href.length > LIMITS.url) {
    return { note: 'website_invalid' };
  }
  return { url: url.href, upgraded };
}

const COMMONS_FILEPATH = [
  'http://commons.wikimedia.org/wiki/Special:FilePath/',
  'https://commons.wikimedia.org/wiki/Special:FilePath/',
];
const BAD_FILE_CHARS = /[#<>[\]|{}/]/u;

/** The decoded Commons file name of a `Special:FilePath` URL, or undefined. The URL itself is dropped. */
function commonsFile(raw: string): string | undefined {
  const prefix = COMMONS_FILEPATH.find((p) => raw.startsWith(p));
  if (prefix === undefined) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(raw.slice(prefix.length)).normalize('NFC');
  } catch {
    return undefined;
  }
  const length = codePointLength(name);
  if (length < 1 || length > LIMITS.commonsFile) return undefined;
  if (BAD_FILE_CHARS.test(name) || hasInvisible(name) || name !== name.trim()) return undefined;
  return name;
}

type Address = {
  street: string;
  houseNumber: string | null;
  postcode: string | null;
  place: string | null;
};

// `Museumplein 6`, `Dorpsstraat 12a`, `Singel 1-3`, `2e Hugo de Grootstraat 14`.
const STREET_NUMBER = /^(.+?)\s+([0-9]+(?:\s?[A-Za-z])?(?:\s?[-/]\s?[0-9]+(?:\s?[A-Za-z])?)?)$/u;
// `Museumplein 6 1071 DJ Amsterdam` (no comma).
const NO_COMMA = /^(.+?)\s+([0-9]+(?:\s?[A-Za-z])?)\s+([1-9][0-9]{3}\s?[A-Za-z]{2})(?:\s+(.+))?$/u;
const POSTCODE_PLACE = /^([1-9][0-9]{3}\s?[A-Za-z]{2})(?:\s+(.+))?$/u;

function optionalText(s: string | undefined, max: number): string | null | undefined {
  if (s === undefined) return null;
  const r = cleanText(s, max);
  if (r.ok) return r.value;
  return r.code === 'empty' ? null : undefined;
}

/** P6375 (street address, monolingual text) into its parts, or null. [U parse rate: A§7.2] */
function parseAddress(raw: string): Address | null {
  const text = cleanText(raw, 400);
  if (!text.ok) return null;
  let streetPart: string;
  let houseNumber: string | undefined;
  let rest: string | undefined;
  const comma = text.value.indexOf(',');
  if (comma >= 0) {
    streetPart = text.value.slice(0, comma).trim();
    rest = text.value
      .slice(comma + 1)
      .split(',')[0]
      ?.trim();
  } else {
    const flat = NO_COMMA.exec(text.value);
    if (flat) {
      streetPart = flat[1] ?? '';
      houseNumber = flat[2];
      rest = [flat[3], flat[4]].filter(Boolean).join(' ');
    } else {
      streetPart = text.value;
    }
  }
  if (houseNumber === undefined) {
    const m = STREET_NUMBER.exec(streetPart);
    if (m) {
      streetPart = m[1] ?? '';
      houseNumber = m[2];
    }
  }
  const street = cleanText(streetPart, LIMITS.street);
  // A street has letters: `?!` or a bare number is not an address.
  if (!street.ok || !/\p{L}/u.test(street.value)) return null;
  const number = optionalText(houseNumber, LIMITS.houseNumber);
  if (number === undefined) return null;
  let pc: string | null = null;
  let placeText: string | undefined = rest;
  if (rest !== undefined) {
    const m = POSTCODE_PLACE.exec(rest);
    if (m) {
      pc = postcode(m[1] ?? '') ?? null;
      placeText = m[2];
    }
  }
  const place = optionalText(placeText, LIMITS.place);
  if (place === undefined) return null;
  return { street: street.value, houseNumber: number, postcode: pc, place };
}

/** `2019-12-31T00:00:00Z` to `2019-12-31`; undefined for anything else (BCE years, unknown values). */
function dateOnly(v: string): string | undefined {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T|$)/.exec(v.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

type Built = { row: WikidataRow } | { invalid: 'label_too_long' | 'no_label' };

function build(qid: string, c: Collected, notes: Set<string>): Built {
  const nl = firstText(sorted(c, 'labelNl'), LIMITS.label);
  const en = firstText(sorted(c, 'labelEn'), LIMITS.label);
  if (nl.tooLong || en.tooLong) return { invalid: 'label_too_long' };
  const name = nl.value ?? en.value;
  if (name === null) return { invalid: 'no_label' };

  const descNl = firstText(sorted(c, 'descNl'), LIMITS.description);
  const descEn = firstText(sorted(c, 'descEn'), LIMITS.description);
  if (descNl.tooLong || descEn.tooLong) notes.add('description_too_long');

  const aliasSet = new Set<string>();
  for (const raw of sorted(c, 'aliases')) {
    const r = cleanText(raw, LIMITS.alias);
    if (r.ok) {
      if (r.value !== name) aliasSet.add(r.value);
    } else if (r.code === 'too_long') {
      notes.add('alias_too_long');
    }
  }
  let aliases = [...aliasSet].sort(byCodeUnit);
  if (aliases.length > MAX_ALIASES) {
    aliases = aliases.slice(0, MAX_ALIASES);
    notes.add('aliases_truncated');
  }

  // Coordinates: the first valid point in sorted order wins.
  let lat: number | null = null;
  let lon: number | null = null;
  const coords = sorted(c, 'coords');
  if (coords.length > 1) notes.add('coord_multiple');
  let coordProblem: string | undefined;
  for (const wkt of coords) {
    const p = parsePoint(wkt);
    if (typeof p === 'string') {
      coordProblem ??= p;
    } else {
      ({ lat, lon } = p);
      break;
    }
  }
  if (lat === null && coordProblem !== undefined) notes.add(coordProblem);

  // A real https value wins over an upgraded http one; within each, the first in sorted order.
  let website: string | null = null;
  let upgradedWebsite: string | null = null;
  let websiteProblem: string | undefined;
  for (const raw of sorted(c, 'websites')) {
    const r = httpsUrl(raw);
    if (!('url' in r)) {
      websiteProblem ??= r.note;
    } else if (!r.upgraded) {
      website = r.url;
      break;
    } else {
      upgradedWebsite ??= r.url;
    }
  }
  if (website === null && upgradedWebsite !== null) {
    website = upgradedWebsite;
    notes.add('website_upgraded');
  }
  if (website === null && websiteProblem !== undefined) notes.add(websiteProblem);

  let address: Address | null = null;
  const addresses = sorted(c, 'addresses');
  for (const raw of addresses) {
    address = parseAddress(raw);
    if (address !== null) break;
  }
  if (addresses.length > 0) notes.add(address === null ? 'address_unparsed' : 'address_parsed');

  // P281 is the postcode when the address has none.
  let pc = address?.postcode ?? null;
  if (pc === null) {
    const candidates = sorted(c, 'postcodes');
    for (const raw of candidates) {
      pc = postcode(raw) ?? null;
      if (pc !== null) break;
    }
    if (pc === null && candidates.length > 0) notes.add('postcode_invalid');
  }

  // The municipality: records "digits FIELD_SEP name FIELD_SEP province", the lowest valid code wins.
  let municipalityCode: string | null = null;
  let municipalityName: string | null = null;
  let provinceCode: string | null = null;
  const records = sorted(c, 'municipalities').map((r) => r.split(FIELD_SEP));
  for (const [digits = ''] of records) {
    const code = /^[0-9]{4}$/.test(digits) ? `GM${digits}` : undefined;
    if (code !== undefined && CBS_CODE.test(code)) {
      municipalityCode = code;
      break;
    }
  }
  if (municipalityCode === null && records.length > 0) notes.add('municipality_bad_code');
  if (municipalityCode !== null) {
    const same = records.filter(([digits]) => `GM${digits}` === municipalityCode);
    municipalityName = same.map(([, n = '']) => firstText([n], LIMITS.municipalityName).value).find((n) => n) ?? null;
    provinceCode = same.map(([, , p = '']) => p.trim()).find((p) => PROVINCE_CODE.test(p)) ?? null;
  }

  let museumnl: string | null = null;
  const hints = sorted(c, 'museumnl');
  for (const raw of hints) {
    const url = isCleanToken(raw) ? museumnlUrl(raw) : undefined;
    if (url !== undefined) {
      museumnl = url;
      break;
    }
  }
  if (museumnl === null && hints.length > 0) notes.add('museumnl_bad_host');

  let file: string | null = null;
  const names = sorted(c, 'images')
    .map(commonsFile)
    .filter((n): n is string => n !== undefined)
    .sort(byCodeUnit);
  if (names.length > 0) file = names[0] ?? null;
  else if (sorted(c, 'images').length > 0) notes.add('commons_file_invalid');

  const classes = [
    ...new Set(
      sorted(c, 'classes')
        .map((u) => qidOf(u))
        .filter((q): q is string => q !== undefined),
    ),
  ]
    .sort(byCodeUnit)
    .slice(0, MAX_CLASSES);

  // The earliest valid P576 date: ISO dates sort by code unit.
  let dissolvedOn: string | null = null;
  const ends = sorted(c, 'dissolved');
  for (const raw of ends) {
    dissolvedOn = dateOnly(raw) ?? null;
    if (dissolvedOn !== null) break;
  }
  if (dissolvedOn === null && ends.length > 0) notes.add('dissolved_bad_date');

  const registered = sorted(c, 'registered').some((v) => v === 'true' || v === '1');

  return {
    row: {
      qid,
      name,
      nameEn: en.value,
      descriptionNl: descNl.value,
      descriptionEn: descEn.value,
      aliases,
      lat,
      lon,
      website,
      street: address?.street ?? null,
      houseNumber: address?.houseNumber ?? null,
      postcode: pc,
      place: address?.place ?? null,
      municipalityCode,
      municipalityName,
      provinceCode,
      registered,
      museumnlUrl: museumnl,
      commonsFile: file,
      classes,
      dissolvedOn,
    },
  };
}

// Numeric order of the digits (no leading zeros): shorter first, then by code unit.
const byQid = (a: string, b: string): number => a.length - b.length || byCodeUnit(a, b);

/** Parses a WDQS `application/sparql-results+json` answer. Never throws. */
export function parseWikidata(json: unknown): ParseResult<WikidataRow> {
  try {
    return parse(json);
  } catch {
    return { ok: false, code: 'schema' };
  }
}

function parse(json: unknown): ParseResult<WikidataRow> {
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return { ok: false, code: 'schema' };

  const invalid = new Map<string, number>();
  const notes = new Map<string, number>();
  const items = new Map<string, Collected>();

  for (const binding of envelope.data.results.bindings) {
    if (!isRecord(binding)) {
      bump(invalid, 'bad_row');
      continue;
    }
    const itemCell = Cell.safeParse(binding.item);
    const qid = itemCell.success ? qidOf(itemCell.data.value) : undefined;
    if (qid === undefined) {
      bump(invalid, 'bad_qid');
      continue;
    }
    const cells = new Map<Var, string>();
    let broken = false;
    for (const name of [...SINGLE_VARS, ...MULTI_VARS]) {
      if (!Object.hasOwn(binding, name)) continue;
      const cell = Cell.safeParse(binding[name]);
      if (!cell.success) {
        broken = true;
        break;
      }
      cells.set(name, cell.data.value);
    }
    if (broken) {
      bump(invalid, 'bad_row');
      continue;
    }
    let collected = items.get(qid);
    if (collected === undefined) {
      collected = new Map();
      items.set(qid, collected);
    }
    for (const [name, value] of cells) {
      const set = collected.get(name) ?? new Set<string>();
      collected.set(name, set);
      if ((MULTI_VARS as readonly string[]).includes(name)) {
        for (const part of value.split(RECORD_SEP)) if (part !== '') set.add(part);
      } else if (value !== '') {
        set.add(value);
      }
    }
  }

  const rows: WikidataRow[] = [];
  for (const qid of [...items.keys()].sort(byQid)) {
    const itemNotes = new Set<string>();
    const built = build(qid, items.get(qid) ?? new Map(), itemNotes);
    if ('invalid' in built) {
      bump(invalid, built.invalid);
      continue;
    }
    // The column shapes, checked once more: a row the database would refuse is dropped here, not in the run.
    if (!wikidataPayload.safeParse(built.row).success) {
      bump(invalid, 'bad_payload');
      continue;
    }
    rows.push(built.row);
    for (const code of itemNotes) bump(notes, code);
  }
  return { ok: true, rows, invalid: plain(invalid), notes: plain(notes) };
}
