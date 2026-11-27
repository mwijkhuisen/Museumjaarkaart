import { describe, expect, it } from 'vitest';
import { MUSEUMNL_HOST } from '../../../src/museums/museumnl.ts';
import { type ImportMuseum, matchRows } from '../../../src/passport/import/match.ts';
import type { ParsedRow } from '../../../src/passport/import/types.ts';

// The import's matching (plan Q3): ids and keys first, then the name rule with its place check.

const KROLLER_URL = `https://${MUSEUMNL_HOST}/nl/kroller-muller`;
const museum = (n: number, over: Partial<ImportMuseum> = {}): ImportMuseum => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  slug: `museum-${n}`,
  name: `Museum ${n}`,
  name_en: null,
  place: null,
  qid: null,
  museumnlUrl: null,
  aliases: [],
  ...over,
});

const row = (ref: Partial<ParsedRow['ref']>, error: ParsedRow['error'] = null): ParsedRow => ({
  row: 1,
  kind: 'visit',
  ref: { mjkId: null, qid: null, museumnlUrl: null, name: null, place: null, ...ref },
  visited_on: null,
  note: null,
  error,
});

const one = (r: ParsedRow, museums: ImportMuseum[]) => matchRows([r], museums)[0];

describe('matchRows', () => {
  const rijks = museum(1, { name: 'Rijksmuseum', place: 'Amsterdam', qid: 'Q190804', aliases: ['Rijks'] });
  const kroller = museum(2, {
    name: 'Kröller-Müller Museum',
    place: 'Otterlo',
    museumnlUrl: KROLLER_URL,
  });

  it('an error row is invalid, whatever else it holds', () => {
    expect(one(row({ qid: 'Q190804', name: 'Rijksmuseum' }, 'bad_date'), [rijks])).toEqual({
      status: 'invalid',
      museumId: null,
      candidateIds: [],
    });
  });

  it('rule 1: the museum id of a visible museum', () => {
    expect(one(row({ mjkId: kroller.id, name: 'Rijksmuseum' }), [rijks, kroller])).toMatchObject({
      status: 'matched',
      museumId: kroller.id,
    });
  });

  it('rule 1 falls through for an unknown id (a hidden museum is not in the list)', () => {
    const hiddenId = museum(99).id;
    expect(one(row({ mjkId: hiddenId, name: 'Rijksmuseum' }), [rijks, kroller])).toMatchObject({
      status: 'matched',
      museumId: rijks.id,
    });
    expect(one(row({ mjkId: hiddenId }), [rijks])).toMatchObject({ status: 'unmatched' });
  });

  it('rule 2: a QID or a museumnl_url we hold, before the name', () => {
    expect(one(row({ qid: 'Q190804', name: 'Kroller' }), [rijks, kroller])).toMatchObject({ museumId: rijks.id });
    expect(one(row({ museumnlUrl: KROLLER_URL, name: 'Rijksmuseum' }), [rijks, kroller])).toMatchObject({
      status: 'matched',
      museumId: kroller.id,
    });
    // An unknown QID falls through to the name.
    expect(one(row({ qid: 'Q1', name: 'Rijksmuseum' }), [rijks])).toMatchObject({ museumId: rijks.id });
  });

  it('rule 2: two museums holding the same key are ambiguous', () => {
    const twin = museum(3, { qid: 'Q190804' });
    expect(one(row({ qid: 'Q190804' }), [rijks, twin])).toEqual({
      status: 'ambiguous',
      museumId: null,
      candidateIds: [rijks.id, twin.id],
    });
  });

  it('rule 3: the normalised name or an alias, case, accents and stop-words aside', () => {
    expect(one(row({ name: 'het RIJKSMUSEUM' }), [rijks, kroller])).toMatchObject({ museumId: rijks.id });
    expect(one(row({ name: 'Kroller Muller' }), [rijks, kroller])).toMatchObject({ museumId: kroller.id });
    expect(one(row({ name: 'Rijks' }), [rijks, kroller])).toMatchObject({ museumId: rijks.id });
  });

  it('rule 3: a similar name is not a match', () => {
    expect(one(row({ name: 'Rijksmuseum Twenthe' }), [rijks, kroller])).toMatchObject({ status: 'unmatched' });
  });

  it('rule 3: the place must agree when the row has one', () => {
    expect(one(row({ name: 'Rijksmuseum', place: 'amsterdam' }), [rijks])).toMatchObject({ museumId: rijks.id });
    expect(one(row({ name: 'Rijksmuseum', place: 'Utrecht' }), [rijks])).toMatchObject({ status: 'unmatched' });
    expect(one(row({ name: 'Rijksmuseum', place: 'Utrecht' }), [museum(5, { name: 'Rijksmuseum' })])).toMatchObject({
      status: 'unmatched',
    });
  });

  it('rule 3: several museums of one name are ambiguous, the place narrows them', () => {
    const a = museum(10, { name: 'Stadsmuseum', place: 'Delft' });
    const b = museum(11, { name: 'Stadsmuseum', place: 'Zwolle' });
    expect(one(row({ name: 'Stadsmuseum' }), [a, b])).toEqual({
      status: 'ambiguous',
      museumId: null,
      candidateIds: [a.id, b.id],
    });
    expect(one(row({ name: 'Stadsmuseum', place: 'Delft' }), [a, b])).toMatchObject({ museumId: a.id });
    expect(one(row({ name: 'Stadsmuseum', place: 'Gouda' }), [a, b])).toMatchObject({ status: 'unmatched' });
  });

  it('an alias that names the same museum as its name counts once', () => {
    const m = museum(12, { name: 'Het Scheepvaartmuseum', aliases: ['Scheepvaartmuseum'] });
    expect(one(row({ name: 'Scheepvaartmuseum' }), [m])).toMatchObject({ status: 'matched', museumId: m.id });
  });

  it('at most 5 candidates, in the museums own order', () => {
    const many = Array.from({ length: 8 }, (_, i) => museum(20 + i, { name: 'Dorpsmuseum' }));
    const r = one(row({ name: 'Dorpsmuseum' }), many);
    expect(r?.status).toBe('ambiguous');
    expect(r?.candidateIds).toEqual(many.slice(0, 5).map((m) => m.id));
  });

  it('an empty normalised name never matches, not even a museum whose own name is only stop-words', () => {
    const odd = museum(30, { name: 'Het Museum' });
    expect(one(row({ name: 'Het Museum' }), [odd])).toMatchObject({ status: 'unmatched' });
    expect(one(row({ name: '   ' }), [odd])).toMatchObject({ status: 'unmatched' });
    expect(one(row({ name: null }), [odd])).toMatchObject({ status: 'unmatched' });
  });

  it('keeps the order and the length of the rows', () => {
    const out = matchRows([row({ name: 'Rijksmuseum' }), row({ name: 'Nergens' }), row({}, 'no_museum')], [rijks]);
    expect(out.map((m) => m.status)).toEqual(['matched', 'unmatched', 'invalid']);
  });
});
