// The sync's pure core (A§7.4, plan §2.4): plan(state, sources, mode) computes
// every write of one run; apply.ts executes it in one transaction. Default
// deny: only SAFE_FIELDS auto-apply, a value going to null queues, pinned
// fields are skipped, nothing is ever deleted, and a run on unchanged input
// plans no write at all.

import { createHash } from 'node:crypto';
import { categoriesOf } from './categories.ts';
import { type ChangeField, MOVE_QUEUE_METRES, SAFE_FIELDS, type Source } from './fields.ts';
import { haversineMetres } from './geo.ts';
import { DEFAULT_MATCH_CONFIG, type MatchCandidate, type MatchConfig, type MatchInput, match } from './match.ts';
import { uniqueSlug } from './slug.ts';
import type { RceRow, WikidataRow } from './sources/types.ts';

export type MatchState = 'matched' | 'new' | 'ambiguous' | 'ignored';
export type MatchRuleState = 'id' | 'postcode_name' | 'distance_name' | 'admin';
export type MatchReason = 'no_candidate' | 'ambiguous' | 'qid_conflict' | 'qid_link' | 'duplicate' | 'dissolved';

/** The source-fed columns of one museum, as the sync reads and writes them. */
export type MuseumFields = {
  wikidata_qid: string | null;
  rce_id: string | null;
  name: string;
  name_en: string | null;
  description_nl: string | null;
  description_en: string | null;
  lat: number | null;
  lon: number | null;
  website: string | null;
  street: string | null;
  house_number: string | null;
  postcode: string | null;
  place: string | null;
  municipality_code: string | null;
  registered: boolean;
  museumnl_url: string | null;
  categories: string[];
  closed_on: string | null;
  commons_file: string | null;
};

export type MuseumState = MuseumFields & {
  id: string;
  slug: string;
  pinned_fields: readonly string[];
  aliases: readonly string[];
};

export type SourceRowState = {
  source: Source;
  external_id: string;
  hash: string;
  matched_museum_id: string | null;
  match_state: MatchState;
  match_rule: MatchRuleState | null;
  match_reason: MatchReason | null;
  candidate_ids: readonly string[];
  gone: boolean;
};

/** A pending change of origin `sync` (the sync never supersedes an admin or a report row). */
export type PendingChange = { id: string; museum_id: string; field: ChangeField; source: Source | null; new: unknown };

export type MunicipalityState = { cbs_code: string; name: string; province_code: string | null };

export type SyncState = {
  museums: readonly MuseumState[];
  sourceRows: readonly SourceRowState[];
  pending: readonly PendingChange[];
  municipalities: readonly MunicipalityState[];
  provinces: readonly string[];
};

export type Sources = { wikidata: readonly WikidataRow[]; rce: readonly RceRow[] };

/** A museum of this plan: one that exists, or one the seed creates (keyed by its QID). */
export type MuseumRef = { id: string } | { key: string };

export type NewMuseum = { key: string; slug: string; fields: Omit<MuseumFields, 'closed_on'>; aliases: string[] };

export type SourceRowWrite = {
  source: Source;
  external_id: string;
  payload: WikidataRow | RceRow;
  hash: string;
  museum: MuseumRef | null;
  match_state: MatchState;
  match_rule: MatchRuleState | null;
  match_reason: MatchReason | null;
  candidates: MuseumRef[];
};

export type ChangeWrite = {
  museumId: string;
  field: ChangeField;
  old: unknown;
  new: unknown;
  source: Source;
  external_id: string | null;
  state: 'applied' | 'pending';
};

export type Counts = {
  rows: Record<Source, number>;
  created: number;
  /** Source rows placed by the matcher in this run, per rule. */
  matched: Record<string, number>;
  /** Source rows whose earlier decision (matched or ignored) stands. */
  kept: number;
  /** Source rows waiting for the owner after this run, per reason. */
  queued: Record<string, number>;
  ignored: number;
  applied: Record<string, number>;
  pending: Record<string, number>;
  superseded: number;
  pinned: number;
  gone: Record<Source, number>;
  returned: number;
  /** Source rows this run leaves untouched. */
  unchanged: number;
};

export type Plan = {
  municipalities: MunicipalityState[];
  create: NewMuseum[];
  update: { museumId: string; set: Partial<MuseumFields> }[];
  aliases: { museum: MuseumRef; alias: string }[];
  sourceRows: SourceRowWrite[];
  gone: { source: Source; external_id: string }[];
  changes: ChangeWrite[];
  supersede: string[];
  counts: Counts;
};

export type PlanConfig = { match: MatchConfig };
export const DEFAULT_PLAN_CONFIG: PlanConfig = { match: DEFAULT_MATCH_CONFIG };

const SAFE = new Set<string>(SAFE_FIELDS);

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with sorted object keys and no `undefined`: the hash of a payload does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byString(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const payloadHash = (payload: unknown) => createHash('sha256').update(canonicalJson(payload)).digest('hex');

const keyOf = (source: Source, externalId: string) => `${source}:${externalId}`;
const refKey = (ref: MuseumRef) => ('id' in ref ? `id:${ref.id}` : `key:${ref.key}`);
const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

type Coordinates = { lat: number; lon: number } | null;
const coordinatesOf = (lat: number | null, lon: number | null): Coordinates =>
  lat === null || lon === null ? null : { lat, lon };

/** What the sources say about a museum; a missing key means no source has an opinion. */
type Target = Partial<Omit<MuseumFields, 'lat' | 'lon' | 'wikidata_qid'>> & { coordinates?: Coordinates };
type TargetField = keyof Target;

/** Field precedence (A§7.2, plan §2.2): a pinned value, then RCE's structured address, then Wikidata. */
function targetOf(
  w: WikidataRow | undefined,
  r: RceRow | undefined,
  knownMunicipality: (code: string | null) => string | null,
): { target: Target; from: Partial<Record<TargetField, Source>> } {
  const target: Target = {};
  const from: Partial<Record<TargetField, Source>> = {};
  const set = <K extends TargetField>(k: K, v: Target[K], s: Source) => {
    target[k] = v;
    from[k] = s;
  };
  if (w) {
    set('name', w.name, 'wikidata');
    set('name_en', w.nameEn, 'wikidata');
    set('description_nl', w.descriptionNl, 'wikidata');
    set('description_en', w.descriptionEn, 'wikidata');
    set('website', w.website, 'wikidata');
    set('registered', w.registered, 'wikidata');
    set('museumnl_url', w.museumnlUrl, 'wikidata');
    set('categories', categoriesOf(w.classes), 'wikidata');
    set('closed_on', w.dissolvedOn, 'wikidata');
    set('commons_file', w.commonsFile, 'wikidata');
    set('municipality_code', knownMunicipality(w.municipalityCode), 'wikidata');
  }
  const rceAddress = r !== undefined && (r.street !== null || r.postcode !== null);
  const address = rceAddress ? r : w;
  if (address) {
    const s: Source = rceAddress ? 'rce' : 'wikidata';
    set('street', address.street, s);
    set('house_number', address.houseNumber, s);
    set('postcode', address.postcode, s);
    set('place', address.place, s);
  }
  const wc = w ? coordinatesOf(w.lat, w.lon) : null;
  const rc = r ? coordinatesOf(r.lat, r.lon) : null;
  if (wc) set('coordinates', wc, 'wikidata');
  else if (rc) set('coordinates', rc, 'rce');
  else if (w) set('coordinates', null, 'wikidata');
  else if (r) set('coordinates', null, 'rce');
  if (r) set('rce_id', r.rceId, 'rce');
  return { target, from };
}

/**
 * The columns of a new museum built from its source rows: the seed's museums, and
 * the owner's `admin match resolve --new`. A museum needs a name, so an RCE row
 * alone gives its RCE name.
 */
export function fieldsFromSources(
  w: WikidataRow | undefined,
  r: RceRow | undefined,
  knownMunicipality: (code: string | null) => string | null,
): Omit<MuseumFields, 'closed_on'> {
  const { target } = targetOf(w, r, knownMunicipality);
  const name = w?.name ?? r?.name;
  if (name === undefined) throw new Error('fieldsFromSources: needs a Wikidata or an RCE row');
  return {
    wikidata_qid: w?.qid ?? null,
    rce_id: target.rce_id ?? null,
    name,
    name_en: target.name_en ?? null,
    description_nl: target.description_nl ?? null,
    description_en: target.description_en ?? null,
    lat: target.coordinates?.lat ?? null,
    lon: target.coordinates?.lon ?? null,
    website: target.website ?? null,
    street: target.street ?? null,
    house_number: target.house_number ?? null,
    postcode: target.postcode ?? null,
    place: target.place ?? null,
    municipality_code: target.municipality_code ?? null,
    registered: target.registered ?? false,
    museumnl_url: target.museumnl_url ?? null,
    categories: target.categories ?? ['other'],
    commons_file: target.commons_file ?? null,
  };
}

const wikidataInput = (w: WikidataRow): MatchInput => ({
  source: 'wikidata',
  qid: w.qid,
  rceId: null,
  museumnlUrl: null,
  name: w.name,
  postcode: w.postcode,
  lat: w.lat,
  lon: w.lon,
});

const rceInput = (r: RceRow): MatchInput => ({
  source: 'rce',
  qid: null,
  rceId: r.rceId,
  museumnlUrl: null,
  name: r.name,
  postcode: r.postcode,
  lat: r.lat,
  lon: r.lon,
});

/** The candidates the rules could pick: the same key, the same postcode, or within ~1 km (rule 3 needs < 150 m). */
function near(all: readonly MatchCandidate[], input: MatchInput): MatchCandidate[] {
  return all.filter(
    (c) =>
      (input.qid !== null && c.qid === input.qid) ||
      (input.rceId !== null && c.rceId === input.rceId) ||
      (input.postcode !== null && c.postcode === input.postcode) ||
      (input.lat !== null &&
        input.lon !== null &&
        c.lat !== null &&
        c.lon !== null &&
        Math.abs(c.lat - input.lat) < 0.01 &&
        Math.abs(c.lon - input.lon) < 0.016),
  );
}

type Placement = {
  source: Source;
  externalId: string;
  payload: WikidataRow | RceRow;
  museum: MuseumRef | null;
  match_state: MatchState;
  match_rule: MatchRuleState | null;
  match_reason: MatchReason | null;
  candidates: MuseumRef[];
  /** An earlier run or the owner decided this row; the sync keeps that decision. */
  kept: boolean;
};
type Placed = Omit<Placement, 'source' | 'externalId' | 'payload'>;

const waiting = (reason: MatchReason, candidates: MuseumRef[] = []): Placed => ({
  museum: null,
  match_state: reason === 'dissolved' ? 'ignored' : reason === 'no_candidate' ? 'new' : 'ambiguous',
  match_rule: null,
  match_reason: reason,
  candidates,
  kept: false,
});

export function plan(state: SyncState, sources: Sources, mode: 'seed' | 'sync', cfg = DEFAULT_PLAN_CONFIG): Plan {
  if (mode === 'seed' && state.museums.length > 0) throw new Error('plan: the seed needs an empty museum table');
  const counts: Counts = {
    rows: { wikidata: sources.wikidata.length, rce: sources.rce.length },
    created: 0,
    matched: {},
    kept: 0,
    queued: {},
    ignored: 0,
    applied: {},
    pending: {},
    superseded: 0,
    pinned: 0,
    gone: { wikidata: 0, rce: 0 },
    returned: 0,
    unchanged: 0,
  };
  const out: Plan = {
    municipalities: [],
    create: [],
    update: [],
    aliases: [],
    sourceRows: [],
    gone: [],
    changes: [],
    supersede: [],
    counts,
  };
  const museums = new Map(state.museums.map((m) => [m.id, m]));
  const existingRows = new Map(state.sourceRows.map((r) => [keyOf(r.source, r.external_id), r]));
  const wikidata = [...sources.wikidata].sort((a, b) => byString(a.qid, b.qid));
  const rce = [...sources.rce].sort((a, b) => byString(a.rceId, b.rceId));

  // Municipalities come from the Wikidata answer (A§7.2): insert new ones, update a changed name or province.
  const provinces = new Set(state.provinces);
  const known = new Map(state.municipalities.map((m) => [m.cbs_code, m]));
  const seen = new Map<string, MunicipalityState>();
  for (const w of wikidata) {
    if (w.municipalityCode === null || w.municipalityName === null || seen.has(w.municipalityCode)) continue;
    const province = w.provinceCode !== null && provinces.has(w.provinceCode) ? w.provinceCode : null;
    seen.set(w.municipalityCode, { cbs_code: w.municipalityCode, name: w.municipalityName, province_code: province });
  }
  for (const m of [...seen.values()].sort((a, b) => byString(a.cbs_code, b.cbs_code))) {
    const k = known.get(m.cbs_code);
    if (!k || k.name !== m.name || k.province_code !== m.province_code) out.municipalities.push(m);
  }
  // A code with no municipality row would break the foreign key: such a museum gets none.
  const knownMunicipality = (code: string | null) =>
    code !== null && (known.has(code) || seen.has(code)) ? code : null;

  // The candidates: every museum we hold, and in the seed the museums it creates (id = their QID).
  const candidates: MatchCandidate[] = state.museums.map((m) => ({
    id: m.id,
    qid: m.wikidata_qid,
    rceId: m.rce_id,
    museumnlUrl: m.museumnl_url,
    name: m.name,
    aliases: m.aliases,
    postcode: m.postcode,
    lat: m.lat,
    lon: m.lon,
  }));
  const ref = (id: string): MuseumRef => (mode === 'seed' ? { key: id } : { id });
  const fromMatch = (input: MatchInput, dissolved: boolean): Placed => {
    const result = match(input, near(candidates, input), cfg.match);
    if (result.kind === 'matched') {
      return {
        museum: ref(result.museumId),
        match_state: 'matched',
        match_rule: result.rule,
        match_reason: null,
        candidates: [],
        kept: false,
      };
    }
    if (result.reason === 'no_candidate') return waiting(dissolved ? 'dissolved' : 'no_candidate');
    return waiting(result.reason, result.candidateIds.map(ref));
  };
  const keep = (e: SourceRowState): Placed => ({
    museum: e.matched_museum_id === null ? null : { id: e.matched_museum_id },
    match_state: e.match_state,
    match_rule: e.match_rule,
    match_reason: e.match_reason,
    candidates: e.candidate_ids.map((id) => ({ id })),
    kept: true,
  });
  const decided = (e: SourceRowState | undefined): e is SourceRowState =>
    e !== undefined && (e.match_state === 'matched' || e.match_state === 'ignored');

  // 1. Wikidata rows. The seed creates every item that is not dissolved (Q1); later a new QID waits.
  const placements: Placement[] = [];
  for (const w of wikidata) {
    const existing = existingRows.get(keyOf('wikidata', w.qid));
    let placed: Placed;
    if (mode === 'seed') {
      if (w.dissolvedOn !== null) placed = waiting('dissolved');
      else {
        placed = {
          museum: { key: w.qid },
          match_state: 'matched',
          match_rule: 'id',
          match_reason: null,
          candidates: [],
          kept: false,
        };
        candidates.push({
          id: w.qid,
          qid: w.qid,
          rceId: null,
          museumnlUrl: null,
          name: w.name,
          aliases: w.aliases,
          postcode: w.postcode,
          lat: w.lat,
          lon: w.lon,
        });
      }
    } else {
      placed = decided(existing) ? keep(existing) : fromMatch(wikidataInput(w), w.dissolvedOn !== null);
    }
    placements.push({ source: 'wikidata', externalId: w.qid, payload: w, ...placed });
  }

  // 2. RCE rows, matched against those museums.
  const rcePlacements: Placement[] = [];
  for (const r of rce) {
    const existing = existingRows.get(keyOf('rce', r.rceId));
    const placed = decided(existing) ? keep(existing) : fromMatch(rceInput(r), false);
    rcePlacements.push({ source: 'rce', externalId: r.rceId, payload: r, ...placed });
  }
  // Two RCE rows on one museum: the newly placed ones wait as `duplicate` (the sync sees this, not the matcher).
  const onMuseum = new Map<string, Placement[]>();
  for (const p of rcePlacements) {
    if (p.museum === null) continue;
    const k = refKey(p.museum);
    onMuseum.set(k, [...(onMuseum.get(k) ?? []), p]);
  }
  for (const group of onMuseum.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      if (p.kept || p.museum === null) continue;
      Object.assign(p, waiting('duplicate', [p.museum]));
    }
  }
  placements.push(...rcePlacements);

  // 3. Source rows: only what is new or changed is written.
  const present = new Set<string>();
  const sameRef = (a: MuseumRef | null, id: string | null) => (a === null ? id === null : 'id' in a && a.id === id);
  for (const p of placements) {
    const k = keyOf(p.source, p.externalId);
    present.add(k);
    if (p.match_state === 'matched') {
      // A museum the seed creates is counted as `created`, not as a match.
      if (p.kept) counts.kept++;
      else if (!(mode === 'seed' && p.source === 'wikidata')) bump(counts.matched, p.match_rule ?? 'id');
    } else if (p.match_state === 'ignored') counts.ignored++;
    else bump(counts.queued, p.match_reason ?? 'no_candidate');
    const hash = payloadHash(p.payload);
    const e = existingRows.get(k);
    const unchanged =
      e !== undefined &&
      !e.gone &&
      e.hash === hash &&
      e.match_state === p.match_state &&
      e.match_rule === p.match_rule &&
      e.match_reason === p.match_reason &&
      sameRef(p.museum, e.matched_museum_id) &&
      p.candidates.every((c) => 'id' in c) &&
      same([...e.candidate_ids].sort(), p.candidates.map((c) => ('id' in c ? c.id : '')).sort());
    if (unchanged) {
      counts.unchanged++;
      continue;
    }
    if (e?.gone) counts.returned++;
    out.sourceRows.push({
      source: p.source,
      external_id: p.externalId,
      payload: p.payload,
      hash,
      museum: p.museum,
      match_state: p.match_state,
      match_rule: p.match_rule,
      match_reason: p.match_reason,
      candidates: p.candidates,
    });
  }

  // The rows each museum is matched to now.
  const wOf = new Map<string, WikidataRow>();
  const rOf = new Map<string, RceRow>();
  for (const p of placements) {
    if (p.museum === null || p.match_state !== 'matched') continue;
    if (p.source === 'wikidata') wOf.set(refKey(p.museum), p.payload as WikidataRow);
    else rOf.set(refKey(p.museum), p.payload as RceRow);
  }

  if (mode === 'seed') {
    const taken = new Set<string>();
    for (const w of wikidata) {
      if (w.dissolvedOn !== null) continue;
      const r = rOf.get(refKey({ key: w.qid }));
      const fields = fieldsFromSources(w, r, knownMunicipality);
      const slug = uniqueSlug(w.name, fields.place ?? w.municipalityName, taken);
      taken.add(slug);
      out.create.push({ key: w.qid, slug, fields, aliases: [...new Set(w.aliases)].filter((a) => a !== w.name) });
      counts.created++;
    }
    return out;
  }

  // 4. Field changes of the museums we hold (A§7.4 + Q4).
  const pendingBy = new Map<string, PendingChange[]>();
  for (const c of state.pending) {
    const k = `${c.museum_id}:${c.field}`;
    pendingBy.set(k, [...(pendingBy.get(k) ?? []), c]);
  }
  const superseded = new Set<string>();
  /** Supersedes the pending changes of a field, except the ones `spare` keeps. */
  const supersede = (museumId: string, field: ChangeField, spare: (c: PendingChange) => boolean = () => false) => {
    for (const c of pendingBy.get(`${museumId}:${field}`) ?? []) if (!spare(c)) superseded.add(c.id);
  };
  const propose = (
    m: MuseumState,
    field: ChangeField,
    old: unknown,
    next: unknown,
    source: Source,
    externalId: string | null,
    safe: boolean,
    write: () => void,
  ) => {
    if (safe) {
      write();
      supersede(m.id, field);
      out.changes.push({ museumId: m.id, field, old, new: next, source, external_id: externalId, state: 'applied' });
      bump(counts.applied, field);
      return;
    }
    // The same news already waits: nothing to add. Other news for this field is superseded by it.
    const isSame = (c: PendingChange) => c.source === source && same(c.new, next);
    const already = (pendingBy.get(`${m.id}:${field}`) ?? []).some(isSame);
    supersede(m.id, field, isSame);
    if (already) return;
    out.changes.push({ museumId: m.id, field, old, new: next, source, external_id: externalId, state: 'pending' });
    bump(counts.pending, field);
  };

  for (const k of [...new Set([...wOf.keys(), ...rOf.keys()])].sort()) {
    const m = museums.get(k.slice('id:'.length));
    if (!m) continue;
    const w = wOf.get(k);
    const r = rOf.get(k);
    const { target, from } = targetOf(w, r, knownMunicipality);
    const pinned = new Set(m.pinned_fields);
    const set: Partial<MuseumFields> = {};
    const externalIdOf = (s: Source) => (s === 'wikidata' ? (w?.qid ?? null) : (r?.rceId ?? null));
    for (const field of (Object.keys(target) as TargetField[]).sort()) {
      const source = from[field] ?? 'wikidata';
      if (field === 'coordinates') {
        if (pinned.has('lat') || pinned.has('lon')) {
          counts.pinned++;
          continue;
        }
        const old = coordinatesOf(m.lat, m.lon);
        const next = target.coordinates ?? null;
        if (same(old, next)) {
          supersede(m.id, 'coordinates');
          continue;
        }
        // Coordinates that appear, or move less than 250 m [U], apply; a bigger move or a removal waits.
        const safe = next !== null && (old === null || haversineMetres(old, next) < MOVE_QUEUE_METRES);
        propose(m, 'coordinates', old, next, source, externalIdOf(source), safe, () => {
          set.lat = next?.lat ?? null;
          set.lon = next?.lon ?? null;
        });
        continue;
      }
      if (pinned.has(field)) {
        counts.pinned++;
        continue;
      }
      const old = m[field];
      const next = target[field];
      if (same(old, next)) {
        supersede(m.id, field);
        continue;
      }
      // Default deny (Q4): a safe field applies, unless its value goes away.
      const safe = SAFE.has(field) && next !== null;
      propose(m, field, old, next, source, externalIdOf(source), safe, () => {
        Object.assign(set, { [field]: next });
      });
    }
    if (Object.keys(set).length > 0) out.update.push({ museumId: m.id, set });
    // New aliases are added, never removed.
    if (w) {
      const have = new Set([m.name, ...m.aliases]);
      for (const alias of w.aliases) {
        if (have.has(alias)) continue;
        have.add(alias);
        out.aliases.push({ museum: { id: m.id }, alias });
      }
    }
  }

  // 5. Presence: a row gone from its source is queued, never deleted; a row that comes back clears it.
  for (const e of [...state.sourceRows].sort((a, b) =>
    byString(keyOf(a.source, a.external_id), keyOf(b.source, b.external_id)),
  )) {
    const matched = e.match_state === 'matched' && e.matched_museum_id !== null && museums.has(e.matched_museum_id);
    if (present.has(keyOf(e.source, e.external_id))) {
      if (e.gone && matched && e.matched_museum_id !== null) {
        supersede(e.matched_museum_id, 'presence', (c) => c.source !== e.source);
      }
      continue;
    }
    if (e.gone) continue;
    out.gone.push({ source: e.source, external_id: e.external_id });
    counts.gone[e.source]++;
    if (!matched || e.matched_museum_id === null) continue;
    const already = (pendingBy.get(`${e.matched_museum_id}:presence`) ?? []).some((c) => c.source === e.source);
    if (already) continue;
    out.changes.push({
      museumId: e.matched_museum_id,
      field: 'presence',
      old: { present: true },
      new: { present: false },
      source: e.source,
      external_id: e.external_id,
      state: 'pending',
    });
    bump(counts.pending, 'presence');
  }

  out.supersede = [...superseded].sort();
  counts.superseded = out.supersede.length;
  return out;
}

/** True when the plan writes nothing: an unchanged re-run. */
export const isEmptyPlan = (p: Plan) =>
  p.municipalities.length === 0 &&
  p.create.length === 0 &&
  p.update.length === 0 &&
  p.aliases.length === 0 &&
  p.sourceRows.length === 0 &&
  p.gone.length === 0 &&
  p.changes.length === 0 &&
  p.supersede.length === 0;
