import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  isEmptyPlan,
  type MuseumState,
  type PendingChange,
  payloadHash,
  plan,
  type SourceRowState,
  type SyncState,
} from '../../src/museums/diff.ts';
import type { RceRow, WikidataRow } from '../../src/museums/sources/types.ts';

// The sync's pure core (plan §2.4, criteria 3 and 4): only the safe fields
// auto-apply, everything else waits; an unchanged re-run plans no write; a row
// that disappears is queued, never deleted. sync.int.test.ts runs the same on
// PostgreSQL with the fixtures.

const w = (qid: string, over: Partial<WikidataRow> = {}): WikidataRow => ({
  qid,
  name: `Museum ${qid}`,
  nameEn: null,
  descriptionNl: null,
  descriptionEn: null,
  aliases: [],
  lat: 52.1,
  lon: 5.1,
  website: `https://example.org/${qid.toLowerCase()}`,
  street: 'Dorpsstraat',
  houseNumber: '1',
  postcode: '1234 AB',
  place: 'Ergens',
  municipalityCode: 'GM0001',
  municipalityName: 'Ergens',
  provinceCode: 'NL-UT',
  registered: false,
  museumnlUrl: null,
  commonsFile: null,
  classes: ['Q207694'],
  dissolvedOn: null,
  ...over,
});

const r = (rceId: string, over: Partial<RceRow> = {}): RceRow => ({
  rceId,
  name: 'Museum',
  street: 'Kerkstraat',
  houseNumber: '2',
  postcode: '1234 AB',
  place: 'Ergens',
  municipalityName: 'Ergens',
  lat: 52.1,
  lon: 5.1,
  ...over,
});

const ID = (n: number) => `0197f0a2-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A museum as the seed would have created it from `row`. */
function museum(n: number, row: WikidataRow, over: Partial<MuseumState> = {}): MuseumState {
  return {
    id: ID(n),
    slug: `museum-${n}`,
    wikidata_qid: row.qid,
    rce_id: null,
    name: row.name,
    name_en: row.nameEn,
    description_nl: row.descriptionNl,
    description_en: row.descriptionEn,
    lat: row.lat,
    lon: row.lon,
    website: row.website,
    street: row.street,
    house_number: row.houseNumber,
    postcode: row.postcode,
    place: row.place,
    municipality_code: row.municipalityCode,
    registered: row.registered,
    museumnl_url: row.museumnlUrl,
    categories: ['art'],
    closed_on: row.dissolvedOn,
    commons_file: row.commonsFile,
    pinned_fields: [],
    aliases: row.aliases,
    ...over,
  };
}

const sourceRow = (
  source: 'wikidata' | 'rce',
  external_id: string,
  payload: unknown,
  museumId: string | null,
): SourceRowState => ({
  source,
  external_id,
  hash: payloadHash(payload),
  matched_museum_id: museumId,
  match_state: museumId === null ? 'new' : 'matched',
  match_rule: museumId === null ? null : 'id',
  match_reason: museumId === null ? 'no_candidate' : null,
  candidate_ids: [],
  gone: false,
});

/** A state after the seed of `rows`: one museum per row, matched. */
function seeded(rows: WikidataRow[], extra: Partial<SyncState> = {}): SyncState {
  return {
    museums: rows.map((row, i) => museum(i + 1, row)),
    sourceRows: rows.map((row, i) => sourceRow('wikidata', row.qid, row, ID(i + 1))),
    pending: [],
    municipalities: [{ cbs_code: 'GM0001', name: 'Ergens', province_code: 'NL-UT' }],
    provinces: ['NL-UT', 'NL-NH'],
    ...extra,
  };
}

const empty: SyncState = { museums: [], sourceRows: [], pending: [], municipalities: [], provinces: ['NL-UT'] };

/** About `metres` north of a point (1° of latitude ≈ 111,195 m). */
const north = (lat: number, metres: number) => lat + metres / 111_195;

describe('seed', () => {
  it('creates every museum that is not dissolved, ignores the dissolved one and queues nothing', () => {
    const rows = [w('Q1'), w('Q2', { postcode: '2345 BC', lat: 52.3 }), w('Q3', { dissolvedOn: '2020-01-01' })];
    const p = plan(empty, { wikidata: rows, rce: [] }, 'seed');
    expect(p.create.map((c) => c.key)).toEqual(['Q1', 'Q2']);
    expect(p.counts).toMatchObject({ created: 2, ignored: 1, queued: {} });
    expect(p.sourceRows.find((s) => s.external_id === 'Q3')).toMatchObject({
      match_state: 'ignored',
      match_reason: 'dissolved',
    });
    expect(p.changes).toEqual([]);
    expect(p.municipalities).toEqual([{ cbs_code: 'GM0001', name: 'Ergens', province_code: 'NL-UT' }]);
  });

  it('matches RCE rows to the new museums: rce_id and the RCE address win, Wikidata coordinates win', () => {
    const rows = [w('Q1', { name: 'Stedelijk Museum Ergens', lat: 52.1, lon: 5.1 })];
    const rce = [
      r('R1', { name: 'Stedelijk Museum Ergens', street: 'Markt', houseNumber: '7', lat: 52.2, lon: 5.2 }),
      r('R2', { name: 'Iets heel anders', postcode: '9999 ZZ', lat: 53.0, lon: 6.0 }),
    ];
    const p = plan(empty, { wikidata: rows, rce }, 'seed');
    expect(p.create[0]?.fields).toMatchObject({
      rce_id: 'R1',
      street: 'Markt',
      house_number: '7',
      lat: 52.1,
      lon: 5.1,
    });
    expect(p.sourceRows.find((s) => s.external_id === 'R1')).toMatchObject({
      match_state: 'matched',
      museum: { key: 'Q1' },
    });
    expect(p.sourceRows.find((s) => s.external_id === 'R2')).toMatchObject({
      match_state: 'new',
      match_reason: 'no_candidate',
    });
    expect(p.counts.matched).toEqual({ postcode_name: 1 });
  });

  it('two RCE rows on one new museum both wait as duplicate', () => {
    const p = plan(
      empty,
      { wikidata: [w('Q1', { name: 'Molen' })], rce: [r('R1', { name: 'Molen' }), r('R2', { name: 'Molen' })] },
      'seed',
    );
    for (const id of ['R1', 'R2']) {
      expect(p.sourceRows.find((s) => s.external_id === id)).toMatchObject({
        match_state: 'ambiguous',
        match_reason: 'duplicate',
        candidates: [{ key: 'Q1' }],
      });
    }
    expect(p.create[0]?.fields.rce_id).toBeNull();
  });

  it('gives unique slugs: -<place>, then -2', () => {
    const rows = [
      w('Q1', { name: 'Stedelijk Museum', place: 'Alkmaar' }),
      w('Q2', { name: 'Stedelijk Museum', place: 'Alkmaar', postcode: '2345 BC', lat: 52.5 }),
      w('Q3', { name: 'Stedelijk Museum', place: 'Alkmaar', postcode: '3456 CD', lat: 52.9 }),
    ];
    expect(plan(empty, { wikidata: rows, rce: [] }, 'seed').create.map((c) => c.slug)).toEqual([
      'stedelijk-museum',
      'stedelijk-museum-alkmaar',
      'stedelijk-museum-2',
    ]);
  });

  it('refuses a table that is not empty', () => {
    expect(() => plan(seeded([w('Q1')]), { wikidata: [w('Q1')], rce: [] }, 'seed')).toThrow();
  });
});

describe('sync: unchanged input', () => {
  it('plans no write at all, and counts every row unchanged', () => {
    const rows = [w('Q1'), w('Q2', { postcode: '2345 BC', lat: 52.4 })];
    const p = plan(seeded(rows), { wikidata: rows, rce: [] }, 'sync');
    expect(isEmptyPlan(p)).toBe(true);
    expect(p.counts).toMatchObject({ unchanged: 2, kept: 2, applied: {}, pending: {} });
  });
});

describe('sync: the safe set applies, everything else waits (default deny)', () => {
  const base = w('Q1', { nameEn: 'Old', descriptionNl: 'oud' });

  it.each([
    ['website', { website: 'https://example.org/new' }, 'website'],
    ['name_en', { nameEn: 'New' }, 'name_en'],
    ['description_nl', { descriptionNl: 'nieuw' }, 'description_nl'],
    ['registered', { registered: true }, 'registered'],
    ['museumnl_url', { museumnlUrl: 'https://www.museum.nl/nl/x' }, 'museumnl_url'],
    ['street', { street: 'Nieuwstraat' }, 'street'],
    ['postcode', { postcode: '1234 AC' }, 'postcode'],
  ] satisfies [string, Partial<WikidataRow>, string][])('%s auto-applies', (_, over, field) => {
    const p = plan(seeded([base]), { wikidata: [{ ...base, ...over }], rce: [] }, 'sync');
    expect(p.changes).toEqual([expect.objectContaining({ field, state: 'applied' })]);
    expect(p.update).toHaveLength(1);
    expect(p.counts.applied).toEqual({ [field]: 1 });
  });

  it.each([
    ['a name change', { name: 'Nieuwe naam' }, 'name'],
    ['categories', { classes: ['Q16735822'] }, 'categories'],
    ['a new P18 image', { commonsFile: 'Gevel.jpg' }, 'commons_file'],
    ['a P576 closure', { dissolvedOn: '2026-10-01' }, 'closed_on'],
    ['a safe field going to null', { website: null }, 'website'],
    ['a description going to null', { descriptionNl: null }, 'description_nl'],
  ] satisfies [string, Partial<WikidataRow>, string][])('%s waits in the queue', (_, over, field) => {
    const p = plan(seeded([base]), { wikidata: [{ ...base, ...over }], rce: [] }, 'sync');
    expect(p.changes).toEqual([expect.objectContaining({ field, state: 'pending' })]);
    expect(p.update).toEqual([]);
  });

  it('a 100 m move applies; a 300 m move waits; coordinates that appear apply; a removal waits', () => {
    const at100 = plan(seeded([base]), { wikidata: [{ ...base, lat: north(base.lat ?? 0, 100) }], rce: [] }, 'sync');
    expect(at100.changes).toEqual([expect.objectContaining({ field: 'coordinates', state: 'applied' })]);
    expect(at100.update[0]?.set).toMatchObject({ lat: north(base.lat ?? 0, 100), lon: base.lon });

    const at300 = plan(seeded([base]), { wikidata: [{ ...base, lat: north(base.lat ?? 0, 300) }], rce: [] }, 'sync');
    expect(at300.changes).toEqual([
      expect.objectContaining({ field: 'coordinates', state: 'pending', old: { lat: base.lat, lon: base.lon } }),
    ]);
    expect(at300.update).toEqual([]);

    const none = { ...base, lat: null, lon: null };
    const appear = plan(seeded([none]), { wikidata: [base], rce: [] }, 'sync');
    expect(appear.changes).toEqual([expect.objectContaining({ field: 'coordinates', state: 'applied' })]);

    const gone = plan(seeded([base]), { wikidata: [none], rce: [] }, 'sync');
    expect(gone.changes).toEqual([expect.objectContaining({ field: 'coordinates', state: 'pending', new: null })]);
  });

  it('a pinned field is never written and is counted', () => {
    const state = seeded([base]);
    const pinnedState = {
      ...state,
      museums: state.museums.map((m) => ({ ...m, pinned_fields: ['website', 'name', 'lat'] })),
    };
    const p = plan(
      pinnedState,
      { wikidata: [{ ...base, website: 'https://example.org/x', name: 'Anders', lat: 52.9 }], rce: [] },
      'sync',
    );
    expect(p.changes).toEqual([]);
    expect(p.update).toEqual([]);
    expect(p.counts.pinned).toBe(3);
  });

  it('adds a new alias, never removes one', () => {
    const state = seeded([{ ...base, aliases: ['Oud'] }]);
    const p = plan(state, { wikidata: [{ ...base, aliases: ['Nieuw'] }], rce: [] }, 'sync');
    expect(p.aliases).toEqual([{ museum: { id: ID(1) }, alias: 'Nieuw' }]);
  });
});

describe('sync: pending changes are idempotent', () => {
  const base = w('Q1');
  const renamed = { ...base, name: 'Nieuwe naam' };
  const pending = (id: string, value: unknown): PendingChange => ({
    id,
    museum_id: ID(1),
    field: 'name',
    source: 'wikidata',
    new: value,
  });

  it('the same news waiting already adds nothing', () => {
    const p = plan(
      seeded([base], { pending: [pending('c1', 'Nieuwe naam')] }),
      { wikidata: [renamed], rce: [] },
      'sync',
    );
    expect(p.changes).toEqual([]);
    expect(p.supersede).toEqual([]);
  });

  it('different news supersedes the waiting change and queues the new value', () => {
    const p = plan(
      seeded([base], { pending: [pending('c1', 'Eerdere naam')] }),
      { wikidata: [renamed], rce: [] },
      'sync',
    );
    expect(p.supersede).toEqual(['c1']);
    expect(p.changes).toEqual([expect.objectContaining({ field: 'name', state: 'pending', new: 'Nieuwe naam' })]);
  });

  it('a source that reverts makes the waiting change moot', () => {
    const p = plan(seeded([base], { pending: [pending('c1', 'Nieuwe naam')] }), { wikidata: [base], rce: [] }, 'sync');
    expect(p.supersede).toEqual(['c1']);
    expect(p.changes).toEqual([]);
  });
});

describe('sync: presence (criterion 4)', () => {
  const rows = [w('Q1'), w('Q2', { postcode: '2345 BC', lat: 52.4 })];

  it('a museum gone from its source is queued, never deleted', () => {
    const p = plan(seeded(rows), { wikidata: [rows[0] as WikidataRow], rce: [] }, 'sync');
    expect(p.gone).toEqual([{ source: 'wikidata', external_id: 'Q2' }]);
    expect(p.changes).toEqual([
      expect.objectContaining({ museumId: ID(2), field: 'presence', state: 'pending', source: 'wikidata' }),
    ]);
    // A plan has no delete operation at all; the grants deny DELETE too (grants.int.test.ts).
    expect(Object.keys(p).sort()).toEqual(
      ['aliases', 'changes', 'counts', 'create', 'gone', 'municipalities', 'sourceRows', 'supersede', 'update'].sort(),
    );
  });

  it('a row that is already gone is not queued again; one that comes back clears its presence change', () => {
    const state = seeded(rows);
    const gone = {
      ...state,
      sourceRows: state.sourceRows.map((s) => (s.external_id === 'Q2' ? { ...s, gone: true } : s)),
      pending: [
        {
          id: 'p1',
          museum_id: ID(2),
          field: 'presence' as const,
          source: 'wikidata' as const,
          new: { present: false },
        },
      ],
    };
    expect(isEmptyPlan(plan(gone, { wikidata: [rows[0] as WikidataRow], rce: [] }, 'sync'))).toBe(true);
    const back = plan(gone, { wikidata: rows, rce: [] }, 'sync');
    expect(back.supersede).toEqual(['p1']);
    expect(back.sourceRows).toEqual([expect.objectContaining({ external_id: 'Q2', match_state: 'matched' })]);
    expect(back.counts.returned).toBe(1);
  });
});

describe('sync: identity never changes by itself', () => {
  it('a new QID with no candidate waits as a new museum', () => {
    const p = plan(
      seeded([w('Q1')]),
      { wikidata: [w('Q1'), w('Q9', { postcode: '9999 ZZ', lat: 53.5, lon: 6.5 })], rce: [] },
      'sync',
    );
    expect(p.sourceRows).toEqual([
      expect.objectContaining({ external_id: 'Q9', match_state: 'new', match_reason: 'no_candidate' }),
    ]);
    expect(p.create).toEqual([]);
  });

  it('a merge (old QID gone, a new QID at the same place under the same name) waits as qid_conflict', () => {
    const old = w('Q1', { name: 'Molenmuseum' });
    const p = plan(seeded([old]), { wikidata: [{ ...old, qid: 'Q2' }], rce: [] }, 'sync');
    expect(p.sourceRows).toEqual([
      expect.objectContaining({
        external_id: 'Q2',
        match_state: 'ambiguous',
        match_reason: 'qid_conflict',
        candidates: [{ id: ID(1) }],
      }),
    ]);
    expect(p.changes).toEqual([expect.objectContaining({ field: 'presence', museumId: ID(1) })]);
    expect(p.update).toEqual([]);
  });

  it('a new RCE row matches an existing museum and sets its rce_id (safe)', () => {
    const row = w('Q1', { name: 'Molenmuseum' });
    const p = plan(
      seeded([row]),
      { wikidata: [row], rce: [r('R1', { name: 'Molenmuseum', street: 'Dorpsstraat', houseNumber: '1' })] },
      'sync',
    );
    expect(p.sourceRows).toEqual([
      expect.objectContaining({ external_id: 'R1', match_state: 'matched', museum: { id: ID(1) } }),
    ]);
    expect(p.changes).toEqual([expect.objectContaining({ field: 'rce_id', state: 'applied', new: 'R1' })]);
  });

  it('an owner decision stands: an ignored row is never re-matched', () => {
    const row = w('Q1', { name: 'Molenmuseum' });
    const rceRow = r('R1', { name: 'Molenmuseum' });
    const state = seeded([row]);
    const ignored = { ...sourceRow('rce', 'R1', rceRow, null), match_state: 'ignored' as const, match_reason: null };
    const p = plan(
      { ...state, sourceRows: [...state.sourceRows, ignored] },
      { wikidata: [row], rce: [rceRow] },
      'sync',
    );
    expect(isEmptyPlan(p)).toBe(true);
  });
});

describe('canonicalJson and payloadHash', () => {
  it('do not depend on key order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(o));
        expect(payloadHash(reversed)).toBe(payloadHash(o));
      }),
    );
  });

  it('a plan on the same input is the same plan, whatever the row order', () => {
    const rows = [
      w('Q1'),
      w('Q2', { postcode: '2345 BC', lat: 52.4, name: 'Ander' }),
      w('Q3', { lat: 52.8, postcode: null }),
    ];
    const rce = [r('R1', { name: 'Museum Q1' }), r('R2', { name: 'Ander', postcode: '2345 BC', lat: 52.4 })];
    const a = plan(empty, { wikidata: rows, rce }, 'seed');
    const b = plan(empty, { wikidata: [...rows].reverse(), rce: [...rce].reverse() }, 'seed');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });
});

describe('sync: a rejection stands', () => {
  const base = w('Q1');
  const renamed = { ...base, name: 'Nieuwe naam' };
  const rejected = (value: unknown): PendingChange => ({
    id: 'r1',
    museum_id: ID(1),
    field: 'name',
    source: 'wikidata',
    new: value,
  });

  it('news the owner rejected is not queued again', () => {
    const p = plan(seeded([base], { rejected: [rejected('Nieuwe naam')] }), { wikidata: [renamed], rce: [] }, 'sync');
    expect(p.changes).toEqual([]);
    expect(p.counts.declined).toBe(1);
  });

  it('other news for that field still queues', () => {
    const p = plan(seeded([base], { rejected: [rejected('Eerdere naam')] }), { wikidata: [renamed], rce: [] }, 'sync');
    expect(p.changes).toEqual([expect.objectContaining({ field: 'name', state: 'pending', new: 'Nieuwe naam' })]);
  });
});
