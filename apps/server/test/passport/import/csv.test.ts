import { IMPORT_ROWS_MAX, isStorable, VISIT_NOTE_MAX } from '@mjk/contracts';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { escapeCell, writeCsv } from '../../../src/museums/csv.ts';
import { parseCsv } from '../../../src/passport/import/csv.ts';
import { VISITS_CSV_HEADER, WISHLIST_CSV_HEADER } from '../../../src/passport/mjk-format.ts';

const TODAY = '2026-11-27';
const ID = '0b0f8f3e-7c1d-4a52-9d0e-2f6c1a8b4e11';
const rowsOf = (text: string) => {
  const r = parseCsv(text, TODAY);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
};
const one = (header: string, cells: string) => rowsOf(`${header}\n${cells}\n`)[0];

it('reads every alias of every column, case-blind and trimmed', () => {
  for (const name of ['museum', 'Naam', 'NAME', ' museumnaam ', 'museum_name']) {
    expect(one(name, 'Rijksmuseum')?.ref.name).toBe('Rijksmuseum');
  }
  for (const place of ['plaats', 'place', 'city', 'stad', 'woonplaats']) {
    expect(one(`museum,${place}`, 'A,Leiden')?.ref.place).toBe('Leiden');
  }
  for (const date of ['datum', 'date', 'bezocht', 'bezoekdatum', 'visit_date', 'visited_on']) {
    expect(one(`museum,${date}`, 'A,2026-01-02')?.visited_on).toBe('2026-01-02');
  }
  for (const note of ['notitie', 'notities', 'opmerking', 'note', 'notes']) {
    expect(one(`museum,${note}`, 'A,mooi')?.note).toBe('mooi');
  }
  for (const qid of ['wikidata', 'qid', 'wikidata_qid']) expect(one(qid, 'Q190804')?.ref.qid).toBe('Q190804');
  for (const url of ['museumnl', 'museumnl_url']) {
    expect(one(url, 'https://www.museum.nl/nl/rijksmuseum')?.ref.museumnlUrl).toBe(
      'https://www.museum.nl/nl/rijksmuseum',
    );
  }
  expect(one('museum_id', ID)?.ref.mjkId).toBe(ID);
});

it('reads both delimiters, a BOM and CRLF, and ignores unknown columns', () => {
  const expected = [{ row: 1, kind: 'visit', visited_on: '2026-03-04', note: 'x', error: null }];
  for (const text of [
    'museum,extra,datum,notitie\r\nA,zzz,2026-03-04,x\r\n',
    '﻿museum;extra;datum;notitie\r\nA;zzz;2026-03-04;x\r\n',
    '"museum";extra;datum;"notitie"\r\n"A";z,z;04-03-2026;"x"\r\n',
  ]) {
    expect(rowsOf(text)).toMatchObject(expected.map((e) => ({ ...e, ref: { name: 'A' } })));
  }
  expect(one('museum;notitie', 'A;"a,b;c"')?.note).toBe('a,b;c');
});

it('reads each date form and judges the calendar, 1900 and the given today', () => {
  const date = (d: string) => one('museum,datum', `A,${d}`);
  for (const d of ['2026-3-4', '2026-03-04', '04-03-2026', '4-3-2026', '04/03/2026', '4/3/2026', '2026/03/04']) {
    expect(date(d)).toMatchObject({ visited_on: '2026-03-04', error: null });
  }
  expect(date('1900-01-01')).toMatchObject({ visited_on: '1900-01-01', error: null });
  expect(date('2024-02-29')).toMatchObject({ error: null });
  for (const d of ['2026-02-30', '31-04-2026', '1899-12-31', 'gisteren', '2026-13-01', '26-3-4']) {
    expect(date(d)).toMatchObject({ visited_on: null, error: 'bad_date' });
  }
  expect(date(TODAY)).toMatchObject({ error: null });
  expect(date('2026-11-28')).toMatchObject({ visited_on: '2026-11-28', error: 'future_date' });
  expect(parseCsv('museum,datum\nA,2026-11-28\n', '2026-11-28')).toMatchObject({ ok: true, rows: [{ error: null }] });
  expect(one('museum,datum', 'A,')).toMatchObject({ visited_on: null, error: null });
});

it('reads a formula-guarded cell from our own export back as text', () => {
  const guarded = writeCsv([[escapeCell('=HYPERLINK("x")'), escapeCell('+31 plaats'), escapeCell('@naam')]]);
  const [row] = rowsOf(`museum,plaats,notitie\r\n${guarded}`);
  expect(row).toMatchObject({ ref: { name: '=HYPERLINK("x")', place: '+31 plaats' }, note: '@naam' });
});

it('gives each row error, first one winning, and keeps the fields that parsed', () => {
  expect(one('museum,datum', 'A,2026-02-30')).toMatchObject({ error: 'bad_date', ref: { name: 'A' } });
  expect(one('museum,datum', ',2026-02-30')).toMatchObject({ error: 'no_museum' });
  expect(one('museum,qid', ',Q0')).toMatchObject({ error: 'no_museum', ref: { qid: null } });
  expect(one('museum,qid', 'A,Q12x')).toMatchObject({ error: null, ref: { qid: null, name: 'A' } });
  expect(one('museumnl', 'https://example.org/x')).toMatchObject({ error: 'no_museum', ref: { museumnlUrl: null } });
  expect(one('museum_id', ID.toUpperCase())).toMatchObject({ error: 'no_museum', ref: { mjkId: null } });
  expect(one('museum', 'x'.repeat(251))).toMatchObject({ error: 'too_long' });
  expect(one('museum', 'x'.repeat(250))).toMatchObject({ error: null });
  expect(one('museum,plaats', `A,${'x'.repeat(251)}`)).toMatchObject({ error: 'too_long' });
  expect(one('museum,notitie', `A,${'x'.repeat(VISIT_NOTE_MAX)}`)).toMatchObject({ error: null });
  expect(one('museum,notitie', `A,${'x'.repeat(VISIT_NOTE_MAX + 1)}`)).toMatchObject({ error: 'too_long' });
  expect(one('museum,datum,notitie', `A,2999-01-01,"a\u{0000}b"`)).toMatchObject({ error: 'bad_text' });
  expect(one('museum', 'a\u{D800}b')).toMatchObject({ error: 'bad_text' });
  expect(one('museum,datum', `${'x'.repeat(251)},nope`)).toMatchObject({ error: 'too_long' });
});

it('numbers the data rows from 1 and skips blank rows without counting them', () => {
  const rows = rowsOf('museum,datum\nA,\n,\n\n  , \nB,\nC');
  expect(rows.map((r) => [r.row, r.ref.name])).toEqual([
    [1, 'A'],
    [2, 'B'],
    [3, 'C'],
  ]);
});

it('refuses a file by its header, quotes or size', () => {
  expect(parseCsv('', TODAY)).toEqual({ ok: false, error: 'no_header' });
  expect(parseCsv('﻿', TODAY)).toEqual({ ok: false, error: 'no_header' });
  expect(parseCsv('museum,datum\n', TODAY)).toEqual({ ok: false, error: 'empty' });
  expect(parseCsv('museum,datum\n\n,\n', TODAY)).toEqual({ ok: false, error: 'empty' });
  expect(parseCsv('datum,notitie\n2026-01-01,x\n', TODAY)).toEqual({ ok: false, error: 'bad_header' });
  expect(parseCsv('museum,naam\nA,B\n', TODAY)).toEqual({ ok: false, error: 'bad_header' });
  expect(parseCsv('museum,museum\nA,B\n', TODAY)).toEqual({ ok: false, error: 'bad_header' });
  expect(parseCsv('museum,"datum\nA,2026-01-01\n', TODAY)).toEqual({ ok: false, error: 'bad_quote' });
});

it('caps the data rows at IMPORT_ROWS_MAX, blank lines aside', () => {
  const body = (n: number) => `museum\n${'A\n'.repeat(n)}`;
  expect(parseCsv(body(IMPORT_ROWS_MAX), TODAY)).toMatchObject({ ok: true });
  expect(parseCsv(body(IMPORT_ROWS_MAX + 1), TODAY)).toEqual({ ok: false, error: 'too_many_rows' });
  expect(parseCsv(body(IMPORT_ROWS_MAX) + '\n'.repeat(50), TODAY)).toMatchObject({ ok: true });
  expect(parseCsv(body(IMPORT_ROWS_MAX) + '\n'.repeat(5000), TODAY)).toEqual({ ok: false, error: 'too_many_rows' });
});

it('reads back the header our own export writes', () => {
  const text = writeCsv([
    [...VISITS_CSV_HEADER],
    [ID, 'Rijksmuseum', 'Amsterdam', '2026-05-06', 'top'],
    [ID, 'B', '', '', ''],
  ]);
  expect(rowsOf(text)).toMatchObject([
    {
      row: 1,
      ref: { mjkId: ID, name: 'Rijksmuseum', place: 'Amsterdam' },
      visited_on: '2026-05-06',
      note: 'top',
      error: null,
    },
    { row: 2, ref: { mjkId: ID, name: 'B', place: null }, visited_on: null, note: null, error: null },
  ]);
  expect(rowsOf(text).map((r) => r.kind)).toEqual(['visit', 'visit']);
});

it('reads our own wishlist.csv as wishlist entries, with no date or note', () => {
  const text = writeCsv([[...WISHLIST_CSV_HEADER], [ID, 'Rijksmuseum', 'Amsterdam', '2026-05-06']]);
  expect(rowsOf(text)).toEqual([
    {
      row: 1,
      kind: 'wishlist',
      ref: { mjkId: ID, qid: null, museumnlUrl: null, name: 'Rijksmuseum', place: 'Amsterdam' },
      visited_on: null,
      note: null,
      error: null,
    },
  ]);
  // A date column wins: a sheet with both columns is a list of visits.
  expect(one('museum,added_on,datum', 'A,2026-01-01,2026-01-02')).toMatchObject({
    kind: 'visit',
    visited_on: '2026-01-02',
  });
});

it('never throws, for any text', () => {
  const unit = fc.constantFrom(
    'museum',
    'datum',
    'notitie',
    'Q1',
    '2026-01-01',
    ',',
    ';',
    '"',
    '\r',
    '\n',
    ' ',
    "'=",
    '\u{D800}',
    '\u{0}',
    'é',
  );
  for (const arb of [
    fc.string({ unit: 'binary' }),
    fc.string({ unit: 'grapheme' }),
    fc.array(unit).map((a) => a.join('')),
  ]) {
    fc.assert(
      fc.property(arb, (s) => {
        const r = parseCsv(s, TODAY);
        expect(typeof r.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  }
  // near-valid: a good header, then random cells
  const cellArb = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 12 }),
    fc.constantFrom('', '2026-02-30', '31-12-2026', 'Q42'),
  );
  fc.assert(
    fc.property(fc.array(fc.array(cellArb, { maxLength: 6 }), { maxLength: 8 }), (rows) => {
      const r = parseCsv(writeCsv([['museum', 'datum', 'notitie', 'qid'], ...rows]), TODAY);
      expect(typeof r.ok).toBe('boolean');
      // What reaches jsonb and the preview is always storable and within its cap, error rows included.
      for (const p of r.ok ? r.rows : [])
        for (const [s, max] of [
          [p.ref.name, 250],
          [p.ref.place, 250],
          [p.note, VISIT_NOTE_MAX],
        ] as const)
          expect(s === null || (isStorable(s) && s.length <= max)).toBe(true);
    }),
    { numRuns: 300 },
  );
});
