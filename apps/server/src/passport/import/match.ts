// The import's matching (A§7.3, A§10, plan Q3): each parsed row against the visible museums, never a hidden
// one. Pure apart from `loadMuseums`. P1a's `match()` decides on keys (QID, address key (museumnl_url)); a row with
// none falls to Q3's name rule; nothing is guessed beyond that (a fuzzy hit is the member's to choose).

import { sql } from 'kysely';
import type { Db } from '../../db/kysely.ts';
import { type MatchCandidate, match } from '../../museums/match.ts';
import { normaliseName } from '../../museums/normalise.ts';
import type { ParsedRow } from './types.ts';

export const CANDIDATES_MAX = 5;

export type ImportMuseum = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  place: string | null;
  qid: string | null;
  museumnlUrl: string | null;
  aliases: string[];
};

export type RowMatch = {
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid';
  museumId: string | null;
  candidateIds: string[];
};

/** Read once per import, as mjk_api: QIDs are not in `pub_museum`. Hidden museums never come back. */
export async function loadMuseums(db: Db): Promise<ImportMuseum[]> {
  const museums = await db
    .selectFrom('museum')
    .select(['id', 'slug', 'name', 'name_en', 'place', 'wikidata_qid', 'museumnl_url'])
    .where('hidden', '=', false)
    .orderBy('name')
    .orderBy('id')
    .execute();
  const { rows: aliases } = await sql<{ museum_id: string; alias: string }>`
    SELECT a.museum_id, a.alias FROM museum_alias a JOIN museum m ON m.id = a.museum_id
     WHERE NOT m.hidden ORDER BY a.alias`.execute(db);
  const byMuseum = new Map<string, string[]>();
  for (const a of aliases) byMuseum.set(a.museum_id, [...(byMuseum.get(a.museum_id) ?? []), a.alias]);
  return museums.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    name_en: m.name_en,
    place: m.place,
    qid: m.wikidata_qid,
    museumnlUrl: m.museumnl_url,
    aliases: byMuseum.get(m.id) ?? [],
  }));
}

export function matchRows(rows: readonly ParsedRow[], museums: readonly ImportMuseum[]): RowMatch[] {
  const byId = new Map(museums.map((m) => [m.id, m]));
  const candidates: MatchCandidate[] = museums.map((m) => ({
    id: m.id,
    qid: m.qid,
    rceId: null,
    museumnlUrl: m.museumnlUrl,
    name: m.name,
    aliases: m.aliases,
    postcode: null,
    lat: null,
    lon: null,
  }));
  // Normalised name or alias → museums, in the museums' own order (by name).
  const byName = new Map<string, ImportMuseum[]>();
  for (const m of museums) {
    for (const key of new Set([m.name, ...m.aliases].map(normaliseName))) {
      if (key === '') continue;
      byName.set(key, [...(byName.get(key) ?? []), m]);
    }
  }

  const ambiguous = (ids: readonly string[]): RowMatch => ({
    status: 'ambiguous',
    museumId: null,
    candidateIds: ids.slice(0, CANDIDATES_MAX),
  });

  return rows.map((r): RowMatch => {
    if (r.error !== null) return { status: 'invalid', museumId: null, candidateIds: [] };
    // 1. The museum's own id (our export carries it).
    if (r.ref.mjkId !== null && byId.has(r.ref.mjkId)) {
      return { status: 'matched', museumId: r.ref.mjkId, candidateIds: [] };
    }
    // 2. P1a's keys: a QID or address key (museumnl_url) we hold. Without either its rule 1 cannot hit, and its
    //    rules 2 and 3 need a postcode or coordinates, which an import row never has: skip the call.
    const keyed = r.ref.qid !== null || r.ref.museumnlUrl !== null;
    const found: ReturnType<typeof match> = !keyed
      ? { kind: 'queue', reason: 'no_candidate', candidateIds: [] }
      : match(
          {
            source: 'import',
            qid: r.ref.qid,
            rceId: null,
            museumnlUrl: r.ref.museumnlUrl,
            name: r.ref.name ?? '',
            postcode: null,
            lat: null,
            lon: null,
          },
          candidates,
        );
    if (found.kind === 'matched') return { status: 'matched', museumId: found.museumId, candidateIds: [] };
    if (found.reason === 'ambiguous') return ambiguous(found.candidateIds);
    // 3. Q3's name rule: the normalised name equals a museum's or one of its aliases, and the place agrees.
    const key = normaliseName(r.ref.name ?? '');
    const place = r.ref.place === null ? '' : normaliseName(r.ref.place);
    const hits =
      key === '' ? [] : (byName.get(key) ?? []).filter((m) => place === '' || normaliseName(m.place ?? '') === place);
    const [only] = hits;
    if (only && hits.length === 1) return { status: 'matched', museumId: only.id, candidateIds: [] };
    if (hits.length > 1) return ambiguous(hits.map((m) => m.id));
    // 4. Nothing: the screen searches the catalogue itself.
    return { status: 'unmatched', museumId: null, candidateIds: [] };
  });
}
