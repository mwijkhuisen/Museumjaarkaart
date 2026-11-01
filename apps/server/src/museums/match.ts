// The matcher (A§7.3, plan §2.3): pure, property-tested. WP4 builds the body;
// this contract is what the sync (WP5) and later the visit imports call.

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

export function match(
  _input: MatchInput,
  _candidates: readonly MatchCandidate[],
  _cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): MatchResult {
  throw new Error('match: not built yet (WP4)');
}
