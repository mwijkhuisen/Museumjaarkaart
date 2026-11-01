import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { haversineMetres } from '../../src/museums/geo.ts';
import {
  DEFAULT_MATCH_CONFIG,
  type MatchCandidate,
  type MatchConfig,
  type MatchInput,
  type MatchResult,
  match,
} from '../../src/museums/match.ts';
import { normaliseName } from '../../src/museums/normalise.ts';
import { similarity } from '../../src/museums/trigram.ts';

const R = 6_371_008.8;
const north = (p: { lat: number; lon: number }, metres: number) => ({
  lat: p.lat + ((metres / R) * 180) / Math.PI,
  lon: p.lon,
});

const SCHIEDAM = { lat: 51.9192, lon: 4.3886 };
const AMSTERDAM = { lat: 52.3584, lon: 4.8811 };
const NAME = 'Stedelijk Museum Schiedam';

const input = (o: Partial<MatchInput> = {}): MatchInput => ({
  source: 'rce',
  qid: null,
  rceId: null,
  museumnlUrl: null,
  name: NAME,
  postcode: null,
  lat: null,
  lon: null,
  ...o,
});
const cand = (id: string, o: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id,
  qid: null,
  rceId: null,
  museumnlUrl: null,
  name: NAME,
  aliases: [],
  postcode: null,
  lat: null,
  lon: null,
  ...o,
});

const matched = (museumId: string, rule: 'id' | 'postcode_name' | 'distance_name'): MatchResult => ({
  kind: 'matched',
  museumId,
  rule,
});
const queue = (reason: 'no_candidate' | 'ambiguous' | 'qid_conflict' | 'qid_link', ...ids: string[]): MatchResult => ({
  kind: 'queue',
  reason,
  candidateIds: ids,
});

// Similarities against NAME (see the exploration in the plan): Alkmaar 0.3846, Zwolle 0.4,
// Breda 0.4783, Amsterdam 0.48, "Museum Schiedam" 0.5, "Stedelijk" 0.5556.
const PC = '3111 AA';

type Case = { name: string; input: MatchInput; candidates: MatchCandidate[]; cfg?: MatchConfig; expected: MatchResult };

const cases: Case[] = [
  {
    name: 'a QID match beats a closer, better-named candidate',
    input: input({ source: 'wikidata', qid: 'Q1', postcode: PC, ...SCHIEDAM }),
    candidates: [
      cand('a', { qid: 'Q1', name: 'Heel Iets Anders', postcode: '9999 ZZ', ...AMSTERDAM }),
      cand('b', { postcode: PC, ...SCHIEDAM }),
    ],
    expected: matched('a', 'id'),
  },
  {
    name: 'an RCE id matches',
    input: input({ rceId: 'r1', name: 'Anders' }),
    candidates: [cand('a', { rceId: 'r1', name: 'Heel Iets' }), cand('b', { rceId: 'r2' })],
    expected: matched('a', 'id'),
  },
  {
    name: 'museumnl_url counts for an import',
    input: input({ source: 'import', museumnlUrl: 'https://example.test/m/1', name: 'Anders' }),
    candidates: [cand('a', { museumnlUrl: 'https://example.test/m/1', name: 'Heel Iets' })],
    expected: matched('a', 'id'),
  },
  {
    name: 'museumnl_url counts for a report',
    input: input({ source: 'report', museumnlUrl: 'https://example.test/m/1', name: 'Anders' }),
    candidates: [cand('a', { museumnlUrl: 'https://example.test/m/1', name: 'Heel Iets' })],
    expected: matched('a', 'id'),
  },
  {
    name: 'museumnl_url does not count for a wikidata row (P973 is stale)',
    input: input({ source: 'wikidata', qid: 'Q9', museumnlUrl: 'https://example.test/m/1', name: 'Anders' }),
    candidates: [cand('a', { museumnlUrl: 'https://example.test/m/1', name: 'Heel Iets' })],
    expected: queue('no_candidate'),
  },
  {
    name: 'museumnl_url does not count for an rce row',
    input: input({ source: 'rce', rceId: 'r9', museumnlUrl: 'https://example.test/m/1', name: 'Anders' }),
    candidates: [cand('a', { museumnlUrl: 'https://example.test/m/1', name: 'Heel Iets' })],
    expected: queue('no_candidate'),
  },
  {
    name: 'postcode rule, similarity 0.4783: over 0.4',
    input: input({ postcode: PC }),
    candidates: [cand('a', { name: 'Stedelijk Museum Breda', postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'postcode rule, similarity exactly 0.4: at the threshold counts',
    input: input({ postcode: PC }),
    candidates: [cand('a', { name: 'Stedelijk Museum Zwolle', postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'postcode rule, similarity 0.3846: under 0.4',
    input: input({ postcode: PC }),
    candidates: [cand('a', { name: 'Stedelijk Museum Alkmaar', postcode: PC })],
    expected: queue('no_candidate'),
  },
  {
    name: 'postcode rule needs the exact postcode string',
    input: input({ postcode: PC }),
    candidates: [cand('a', { postcode: '3111 AB' }), cand('b', { postcode: '3111AA' })],
    expected: queue('no_candidate'),
  },
  {
    name: 'distance rule at 149 m',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { ...north(SCHIEDAM, 149) })],
    expected: matched('a', 'distance_name'),
  },
  {
    name: 'distance rule at 151 m',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { ...north(SCHIEDAM, 151) })],
    expected: queue('no_candidate'),
  },
  {
    name: 'distance rule is strict: a candidate exactly at the limit does not pass',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { ...north(SCHIEDAM, 100) })],
    cfg: {
      ...DEFAULT_MATCH_CONFIG,
      distanceMetres: haversineMetres(SCHIEDAM, north(SCHIEDAM, 100)),
    },
    expected: queue('no_candidate'),
  },
  {
    name: 'distance rule, similarity exactly 0.5: at the threshold counts',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { name: 'Museum Schiedam', ...north(SCHIEDAM, 50) })],
    expected: matched('a', 'distance_name'),
  },
  {
    name: 'distance rule, similarity 0.48: under 0.5',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { name: 'Stedelijk Museum Amsterdam', ...north(SCHIEDAM, 50) })],
    expected: queue('no_candidate'),
  },
  {
    name: 'two Stedelijk Museums in different places: the near one wins',
    input: input({ ...SCHIEDAM }),
    candidates: [
      cand('ams', { name: 'Stedelijk Museum Amsterdam', ...AMSTERDAM }),
      cand('sch', { ...north(SCHIEDAM, 20) }),
    ],
    expected: matched('sch', 'distance_name'),
  },
  {
    name: 'two Stedelijk Museums at one postcode are ambiguous',
    input: input({ name: 'Stedelijk Museum', postcode: PC }),
    candidates: [
      cand('b', { name: 'Stedelijk Museum', postcode: PC }),
      cand('a', { name: 'Stedelijk Museum', postcode: PC }),
    ],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'two near candidates are ambiguous at the distance rule',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a', { ...north(SCHIEDAM, 10) }), cand('b', { ...north(SCHIEDAM, 30) })],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'one name at two postcodes: the postcode picks',
    input: input({ postcode: PC }),
    candidates: [cand('a', { postcode: '1011 AA' }), cand('b', { postcode: PC })],
    expected: matched('b', 'postcode_name'),
  },
  {
    name: 'one name at two postcodes, input at a third: nothing',
    input: input({ postcode: '8888 XX' }),
    candidates: [cand('a', { postcode: '1011 AA' }), cand('b', { postcode: PC })],
    expected: queue('no_candidate'),
  },
  {
    name: 'no coordinates and no postcode: a perfect name alone matches nothing',
    input: input(),
    candidates: [cand('a')],
    expected: queue('no_candidate'),
  },
  {
    name: 'coordinates on one side only',
    input: input({ ...SCHIEDAM }),
    candidates: [cand('a'), cand('b', { lat: SCHIEDAM.lat, lon: null })],
    expected: queue('no_candidate'),
  },
  {
    name: 'no candidates',
    input: input({ postcode: PC, ...SCHIEDAM }),
    candidates: [],
    expected: queue('no_candidate'),
  },
  {
    name: 'hostile name: markup is just text',
    input: input({ name: '</script><img src=x onerror=alert(1)>', postcode: PC }),
    candidates: [cand('a', { name: '</script><img src=x onerror=alert(1)>', postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'hostile name: bidi controls and a zero-width joiner do not hide a match',
    input: input({ name: '‮stedelijk‬ ‍museum⁦ schiedam', postcode: PC }),
    candidates: [cand('a', { postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'hostile name: 5,000 characters on both sides',
    input: input({ name: 'a'.repeat(5000), postcode: PC }),
    candidates: [cand('a', { name: 'a'.repeat(5000), postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'hostile name: 5,000 characters against a short one',
    input: input({ name: 'x'.repeat(5000), postcode: PC }),
    candidates: [cand('a', { postcode: PC })],
    expected: queue('no_candidate'),
  },
  {
    name: 'a name of only stop-words matches nothing by name',
    input: input({ name: 'Het Museum', postcode: PC }),
    candidates: [cand('a', { name: 'De Musea', postcode: PC })],
    expected: queue('no_candidate'),
  },
  {
    name: 'an alias matches',
    input: input({ postcode: PC }),
    candidates: [cand('a', { name: 'Iets Heel Anders', aliases: ['Nope', NAME], postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'a new QID against a museum with another QID is a qid_conflict',
    input: input({ source: 'wikidata', qid: 'Q2', postcode: PC }),
    candidates: [cand('a', { qid: 'Q1', postcode: PC })],
    expected: queue('qid_conflict', 'a'),
  },
  {
    name: 'a new QID against a museum without a QID is a qid_link (distance rule)',
    input: input({ source: 'wikidata', qid: 'Q2', ...SCHIEDAM }),
    candidates: [cand('a', { ...north(SCHIEDAM, 40) })],
    expected: queue('qid_link', 'a'),
  },
  {
    name: 'a new QID with two hits stays ambiguous',
    input: input({ source: 'wikidata', qid: 'Q2', postcode: PC }),
    candidates: [cand('a', { qid: 'Q1', postcode: PC }), cand('b', { postcode: PC })],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'a new QID with no hit is a new museum',
    input: input({ source: 'wikidata', qid: 'Q2', postcode: PC }),
    candidates: [cand('a', { qid: 'Q1', name: 'Rijksmuseum Twenthe', postcode: PC })],
    expected: queue('no_candidate'),
  },
  {
    name: 'an import with a QID still auto-matches through rules 2 and 3',
    input: input({ source: 'import', qid: 'Q2', postcode: PC }),
    candidates: [cand('a', { qid: 'Q1', postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'an RCE row against a museum that holds another rce_id (rule 2)',
    input: input({ rceId: 'r1', postcode: PC }),
    candidates: [cand('a', { rceId: 'r2', postcode: PC })],
    expected: queue('ambiguous', 'a'),
  },
  {
    name: 'an RCE row against a museum that holds another rce_id (rule 3)',
    input: input({ rceId: 'r1', ...SCHIEDAM }),
    candidates: [cand('a', { rceId: 'r2', ...north(SCHIEDAM, 10) })],
    expected: queue('ambiguous', 'a'),
  },
  {
    name: 'an RCE row against a museum without an rce_id matches',
    input: input({ rceId: 'r1', postcode: PC }),
    candidates: [cand('a', { qid: 'Q1', postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'ambiguity at rule 1: two candidates with the same rce_id',
    input: input({ rceId: 'r1' }),
    candidates: [cand('b', { rceId: 'r1' }), cand('a', { rceId: 'r1' })],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'ambiguity at rule 1: a QID and an rce_id point at different museums',
    input: input({ source: 'wikidata', qid: 'Q1', rceId: 'r1' }),
    candidates: [cand('a', { qid: 'Q1' }), cand('b', { rceId: 'r1' })],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'one museum hit by two keys is still one candidate',
    input: input({ source: 'wikidata', qid: 'Q1', rceId: 'r1' }),
    candidates: [cand('a', { qid: 'Q1', rceId: 'r1' })],
    expected: matched('a', 'id'),
  },
  {
    name: 'an ambiguous rule 2 is final: rule 3 is not consulted',
    input: input({ postcode: PC, ...SCHIEDAM }),
    candidates: [
      cand('a', { postcode: PC }),
      cand('b', { postcode: PC }),
      cand('c', { postcode: '1111 AA', ...north(SCHIEDAM, 10) }),
    ],
    expected: queue('ambiguous', 'a', 'b'),
  },
  {
    name: 'a single rule 2 hit decides even when rule 3 has another candidate',
    input: input({ postcode: PC, ...SCHIEDAM }),
    candidates: [
      cand('far', { postcode: PC, ...AMSTERDAM }),
      cand('near', { postcode: '1111 AA', ...north(SCHIEDAM, 10) }),
    ],
    expected: matched('far', 'postcode_name'),
  },
  {
    name: 'an empty-string key never matches',
    input: input({ source: 'import', qid: '', rceId: '', museumnlUrl: '' }),
    candidates: [cand('a', { qid: '', rceId: '', museumnlUrl: '', name: 'Rijksmuseum Twenthe' })],
    expected: queue('no_candidate'),
  },
  {
    name: 'NaN and infinite coordinates match nothing and do not throw',
    input: input({ lat: Number.NaN, lon: 4 }),
    candidates: [cand('a', { lat: Number.POSITIVE_INFINITY, lon: 4 }), cand('b', { lat: Number.NaN, lon: 4 })],
    expected: queue('no_candidate'),
  },
  {
    name: 'a candidate listed twice counts once',
    input: input({ postcode: PC }),
    candidates: [cand('a', { postcode: PC }), cand('a', { postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
  {
    name: 'accents and punctuation do not matter',
    input: input({ name: 'Stédelijk Müseum Schiedam!', postcode: PC }),
    candidates: [cand('a', { postcode: PC })],
    expected: matched('a', 'postcode_name'),
  },
];

describe('match: table', () => {
  it('has at least 24 cases', () => expect(cases.length).toBeGreaterThanOrEqual(24));
  for (const c of cases) {
    it(c.name, () => {
      expect(match(c.input, c.candidates, c.cfg)).toEqual(c.expected);
    });
  }
});

describe('match: thresholds', () => {
  const inp = input({ postcode: PC });
  const cs = [cand('a', { name: 'Stedelijk Museum Breda', postcode: PC })];
  it('postcodeSimilarity just under and just over the similarity of the pair', () => {
    const s = similarity(normaliseName(NAME), normaliseName('Stedelijk Museum Breda'));
    expect(match(inp, cs, { ...DEFAULT_MATCH_CONFIG, postcodeSimilarity: s })).toEqual(matched('a', 'postcode_name'));
    expect(match(inp, cs, { ...DEFAULT_MATCH_CONFIG, postcodeSimilarity: s - 1e-3 })).toEqual(
      matched('a', 'postcode_name'),
    );
    expect(match(inp, cs, { ...DEFAULT_MATCH_CONFIG, postcodeSimilarity: s + 1e-3 })).toEqual(queue('no_candidate'));
  });
  it('a float4-rounded similarity still passes a threshold of the same decimal value', () => {
    // 'Stedelijk Museum Zwolle' scores 2/5; float4(0.4) must not fall under the double 0.4.
    const zwolle = [cand('a', { name: 'Stedelijk Museum Zwolle', postcode: PC })];
    expect(match(inp, zwolle, { ...DEFAULT_MATCH_CONFIG, postcodeSimilarity: 0.4 })).toEqual(
      matched('a', 'postcode_name'),
    );
  });
});

// ---------------------------------------------------------------------------
// Properties

const WORDS = ['stedelijk', 'museum', 'schiedam', 'alkmaar', 'kunst', 'hal', 'molen', 'het', 'oud', 'x'];
const POSTCODES = ['1111 AA', '1111 AB', '2222 BB'];
const LATS = [51.9192, 51.9193, 51.9194, 51.92, 52.1];
const idKey = fc.constantFrom('Q1', 'Q2', 'Q3', 'Q4', null);
const rceKey = fc.constantFrom('r1', 'r2', 'r3', null);
const urlKey = fc.constantFrom('u1', 'u2', null);
const nameArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
const coordArb = fc
  .constantFrom(...LATS)
  .chain((lat) => fc.constantFrom(4.3886, 4.3887, 4.39).map((lon) => ({ lat, lon })));
const placeArb = fc.oneof(fc.constant({ lat: null, lon: null }), coordArb);
const sourceArb = fc.constantFrom<MatchInput['source']>('wikidata', 'rce', 'import', 'report');

const inputArb: fc.Arbitrary<MatchInput> = fc
  .tuple(sourceArb, idKey, rceKey, urlKey, nameArb, fc.constantFrom(...POSTCODES, null), placeArb)
  .map(([source, qid, rceId, museumnlUrl, name, postcode, p]) => ({
    source,
    qid,
    rceId,
    museumnlUrl,
    name,
    postcode,
    ...p,
  }));

const candidatesArb: fc.Arbitrary<MatchCandidate[]> = fc
  .array(
    fc.tuple(
      idKey,
      rceKey,
      urlKey,
      nameArb,
      fc.array(nameArb, { maxLength: 2 }),
      fc.constantFrom(...POSTCODES, null),
      placeArb,
    ),
    { maxLength: 8 },
  )
  .map((rows) =>
    rows.map(([qid, rceId, museumnlUrl, name, aliases, postcode, p], i) => ({
      id: `m${i}`,
      qid,
      rceId,
      museumnlUrl,
      name,
      aliases,
      postcode,
      ...p,
    })),
  );

const cfgArb: fc.Arbitrary<MatchConfig> = fc.record({
  postcodeSimilarity: fc.double({ min: 0, max: 1, noNaN: true }),
  distanceMetres: fc.double({ min: 0, max: 500, noNaN: true }),
  distanceSimilarity: fc.double({ min: 0, max: 1, noNaN: true }),
});

// An independent oracle for how many candidates pass each rule.
function hits(inp: MatchInput, cs: readonly MatchCandidate[], cfg: MatchConfig) {
  const k = (s: string | null) => s !== null && s !== '';
  const sim = (c: MatchCandidate) =>
    Math.max(...[c.name, ...c.aliases].map((n) => similarity(normaliseName(inp.name), normaliseName(n))));
  const url = inp.source === 'import' || inp.source === 'report';
  return {
    id: cs.filter(
      (c) =>
        (k(inp.qid) && c.qid === inp.qid) ||
        (k(inp.rceId) && c.rceId === inp.rceId) ||
        (url && k(inp.museumnlUrl) && c.museumnlUrl === inp.museumnlUrl),
    ).length,
    postcode_name: cs.filter(
      (c) => k(inp.postcode) && c.postcode === inp.postcode && sim(c) >= Math.fround(cfg.postcodeSimilarity),
    ).length,
    distance_name: cs.filter(
      (c) =>
        inp.lat !== null &&
        inp.lon !== null &&
        c.lat !== null &&
        c.lon !== null &&
        haversineMetres({ lat: inp.lat, lon: inp.lon }, { lat: c.lat, lon: c.lon }) < cfg.distanceMetres &&
        sim(c) >= Math.fround(cfg.distanceSimilarity),
    ).length,
  };
}

describe('match: properties', () => {
  it('shuffling the candidates never changes the result', () => {
    fc.assert(
      fc.property(
        inputArb,
        candidatesArb.chain((cs) =>
          fc.tuple(fc.constant(cs), fc.shuffledSubarray(cs, { minLength: cs.length, maxLength: cs.length })),
        ),
        cfgArb,
        (inp, [cs, shuffled], cfg) => {
          expect(match(inp, shuffled, cfg)).toEqual(match(inp, cs, cfg));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a QID match always wins, whatever other candidates are added', () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 8 }), inputArb, cfgArb, (others, at, inp, cfg) => {
        const target = cand('target', { qid: 'Q777', name: 'Heel Iets Anders' });
        // Unique QIDs: no other candidate holds Q777; the input holds no other key.
        const cs = others.map((c) => ({ ...c, qid: c.qid === 'Q777' ? null : c.qid }));
        cs.splice(Math.min(at, cs.length), 0, target);
        const wd: MatchInput = { ...inp, source: 'wikidata', qid: 'Q777', rceId: null, museumnlUrl: null };
        expect(match(wd, cs, cfg)).toEqual(matched('target', 'id'));
      }),
      { numRuns: 300 },
    );
  });

  it('is never matched when two candidates pass the deciding rule, and matched only through a rule with exactly one', () => {
    fc.assert(
      fc.property(inputArb, candidatesArb, cfgArb, (inp, cs, cfg) => {
        const h = hits(inp, cs, cfg);
        const r = match(inp, cs, cfg);
        const first =
          h.id > 0 ? 'id' : h.postcode_name > 0 ? 'postcode_name' : h.distance_name > 0 ? 'distance_name' : null;
        if (first === null) {
          expect(r).toEqual(queue('no_candidate'));
        } else if (h[first] >= 2) {
          expect(r).toMatchObject({ kind: 'queue', reason: 'ambiguous' });
          expect(r.kind === 'queue' && r.candidateIds).toHaveLength(h[first]);
        } else if (r.kind === 'matched') {
          expect(r.rule).toBe(first);
        }
        if (r.kind === 'queue') expect(r.candidateIds).toEqual([...r.candidateIds].sort());
      }),
      { numRuns: 500 },
    );
  });

  it('raising any threshold never turns a no_candidate into a match, and never touches an id match', () => {
    // Not "no queue becomes a match": a stricter threshold can drop one of two ambiguous hits,
    // and the one left is a fair match. What cannot happen is a match out of nothing.
    fc.assert(
      fc.property(
        inputArb,
        candidatesArb,
        cfgArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (inp, cs, cfg, up1, up2, down) => {
          const stricter: MatchConfig = {
            postcodeSimilarity: Math.min(1, cfg.postcodeSimilarity + up1),
            distanceSimilarity: Math.min(1, cfg.distanceSimilarity + up2),
            distanceMetres: cfg.distanceMetres * (1 - down),
          };
          const before = match(inp, cs, cfg);
          const after = match(inp, cs, stricter);
          if (before.kind === 'queue' && before.reason === 'no_candidate') expect(after).toEqual(before);
          if (before.kind === 'matched' && before.rule === 'id') expect(after).toEqual(before);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary strings and numbers', () => {
    const str = fc.string({ unit: 'binary', maxLength: 40 });
    const num = fc.oneof(fc.double(), fc.integer(), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -0));
    const nul = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });
    const anyInput: fc.Arbitrary<MatchInput> = fc.record({
      source: sourceArb,
      qid: nul(str),
      rceId: nul(str),
      museumnlUrl: nul(str),
      name: str,
      postcode: nul(str),
      lat: nul(num),
      lon: nul(num),
    });
    const anyCand: fc.Arbitrary<MatchCandidate> = fc.record({
      id: str,
      qid: nul(str),
      rceId: nul(str),
      museumnlUrl: nul(str),
      name: str,
      aliases: fc.array(str, { maxLength: 3 }),
      postcode: nul(str),
      lat: nul(num),
      lon: nul(num),
    });
    const anyCfg = fc.record({ postcodeSimilarity: num, distanceMetres: num, distanceSimilarity: num });
    fc.assert(
      fc.property(anyInput, fc.array(anyCand, { maxLength: 6 }), anyCfg, (inp, cs, cfg) => {
        const r = match(inp, cs, cfg);
        expect(['matched', 'queue']).toContain(r.kind);
      }),
      { numRuns: 500 },
    );
  });
});
