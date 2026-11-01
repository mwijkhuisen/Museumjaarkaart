// The matcher (A§7.3, plan §2.3): pure, property-tested. WP4 builds the body;
// this contract is what the sync (WP5) and later the visit imports call.

import { haversineMetres } from './geo.ts';
import { normaliseName } from './normalise.ts';
import { similaritySets, trigrams } from './trigram.ts';

export type MatchSource = 'wikidata' | 'rce' | 'import' | 'report';

/** The thing to place: a source row, an import line or a report. */
export type MatchInput = {
  source: MatchSource;
  qid: string | null;
  rceId: string | null;
  /** Rule 1 uses it for `import` and `report` only (P973 on Wikidata is stale, A§7.2). */
  museumnlUrl: string | null;
  name: string;
  postcode: string | null;
  lat: number | null;
  lon: number | null;
};

/** A museum we already hold. */
export type MatchCandidate = {
  id: string;
  qid: string | null;
  rceId: string | null;
  museumnlUrl: string | null;
  name: string;
  aliases: readonly string[];
  postcode: string | null;
  lat: number | null;
  lon: number | null;
};

export type MatchRule = 'id' | 'postcode_name' | 'distance_name';

/**
 * Why a row waits for the owner:
 * - `no_candidate`: no rule found a museum (a new museum)
 * - `ambiguous`: two or more candidates passed the deciding rule
 * - `qid_conflict`: a Wikidata row with an unknown QID hits a museum that has another QID (merge or redirect)
 * - `qid_link`: a Wikidata row with an unknown QID hits a museum without a QID (it would set the main key)
 */
export type QueueReason = 'no_candidate' | 'ambiguous' | 'qid_conflict' | 'qid_link';

export type MatchResult =
  | { kind: 'matched'; museumId: string; rule: MatchRule }
  | { kind: 'queue'; reason: QueueReason; candidateIds: string[] };

export type MatchConfig = {
  /** Rule 2: the same postcode and a name similarity at or above this. */
  postcodeSimilarity: number;
  /** Rule 3: a distance strictly under this many metres… */
  distanceMetres: number;
  /** …and a name similarity at or above this. */
  distanceSimilarity: number;
};

/** [U] Calibrated on the recorded fixtures and the [box] run (A§7.3). */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  postcodeSimilarity: 0.4,
  distanceMetres: 150,
  distanceSimilarity: 0.5,
};

/** A null or empty key never matches anything. */
const has = (s: string | null): s is string => s !== null && s !== '';

const hasCoords = (x: { lat: number | null; lon: number | null }): x is { lat: number; lon: number } =>
  x.lat !== null && x.lon !== null && Number.isFinite(x.lat) && Number.isFinite(x.lon);

/** One entry per museum id, sorted, so the candidate order never shows in the result. */
function uniqueById(hits: readonly MatchCandidate[]): MatchCandidate[] {
  const byId = new Map<string, MatchCandidate>();
  for (const h of hits) byId.set(h.id, h);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const ambiguous = (hits: readonly MatchCandidate[]): MatchResult => ({
  kind: 'queue',
  reason: 'ambiguous',
  candidateIds: hits.map((h) => h.id),
});

/**
 * The first rule with at least one passing candidate decides (plan §2.3): one
 * candidate is the answer, two or more queue as ambiguous. Rules 2 and 3 never
 * link a new Wikidata QID by themselves, and an RCE row never takes over a
 * museum that already holds another RCE row.
 */
export function match(
  input: MatchInput,
  candidates: readonly MatchCandidate[],
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): MatchResult {
  // Rule 1: a key we already hold.
  const useUrl = input.source === 'import' || input.source === 'report';
  const byId = uniqueById(
    candidates.filter(
      (c) =>
        (has(input.qid) && c.qid === input.qid) ||
        (has(input.rceId) && c.rceId === input.rceId) ||
        (useUrl && has(input.museumnlUrl) && c.museumnlUrl === input.museumnlUrl),
    ),
  );
  if (byId.length === 1 && byId[0]) return { kind: 'matched', museumId: byId[0].id, rule: 'id' };
  if (byId.length > 1) return ambiguous(byId);

  // pg_trgm compares a float4 with a float4, so the thresholds are rounded the same way.
  const inputTrigrams = trigrams(normaliseName(input.name));
  const nameOk = (c: MatchCandidate, threshold: number): boolean => {
    const t = Math.fround(threshold);
    return [c.name, ...c.aliases].some((n) => similaritySets(inputTrigrams, trigrams(normaliseName(n))) >= t);
  };

  const rules: [MatchRule, (c: MatchCandidate) => boolean][] = [
    ['postcode_name', (c) => has(input.postcode) && c.postcode === input.postcode && nameOk(c, cfg.postcodeSimilarity)],
    [
      'distance_name',
      (c) =>
        hasCoords(input) &&
        hasCoords(c) &&
        haversineMetres(input, c) < cfg.distanceMetres &&
        nameOk(c, cfg.distanceSimilarity),
    ],
  ];
  for (const [rule, passes] of rules) {
    const hits = uniqueById(candidates.filter(passes));
    const [hit] = hits;
    if (!hit) continue;
    if (hits.length > 1) return ambiguous(hits);
    // A new QID never links automatically: the owner decides.
    if (input.source === 'wikidata' && has(input.qid)) {
      return { kind: 'queue', reason: has(hit.qid) ? 'qid_conflict' : 'qid_link', candidateIds: [hit.id] };
    }
    // One row per source: this museum already has a different RCE row.
    if (input.source === 'rce' && has(hit.rceId) && hit.rceId !== input.rceId) return ambiguous(hits);
    return { kind: 'matched', museumId: hit.id, rule };
  }
  return { kind: 'queue', reason: 'no_candidate', candidateIds: [] };
}
