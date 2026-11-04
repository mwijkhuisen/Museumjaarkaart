import fc from 'fast-check';
import { expect, it } from 'vitest';
import { escapeCell, readCsv, unescapeCell, writeCsv } from '../../src/museums/csv.ts';

// A small alphabet that hits every special case: quotes, commas, CR, LF, the formula starters.
const cell = fc.string({
  unit: fc.constantFrom('a', 'b', ' ', '"', ',', '\r', '\n', '=', '+', '-', '@', '\t', "'", 'é'),
});

it('round-trips arbitrary rectangular string matrices', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5 }).chain((cols) => fc.array(fc.array(cell, { minLength: cols, maxLength: cols }))),
      (rows) => {
        expect(readCsv(writeCsv(rows))).toEqual({ ok: true, rows });
      },
    ),
    { numRuns: 500 },
  );
});

it('round-trips escapeCell and unescapeCell for any string', () => {
  fc.assert(
    fc.property(cell, (v) => {
      expect(unescapeCell(escapeCell(v))).toBe(v);
    }),
    { numRuns: 1000 },
  );
});

it('writes CRLF line ends and quotes only where needed', () => {
  expect(writeCsv([['a', 'b,c', 'd"e', 'f\ng']])).toBe('a,"b,c","d""e","f\ng"\r\n');
});

it('reads a final line with or without a line end, and a BOM', () => {
  expect(readCsv('﻿a,b\r\nc,d')).toEqual({
    ok: true,
    rows: [
      ['a', 'b'],
      ['c', 'd'],
    ],
  });
  expect(readCsv('a\nb\n')).toEqual({ ok: true, rows: [['a'], ['b']] });
  expect(readCsv('')).toEqual({ ok: true, rows: [] });
  expect(readCsv('"a\r\nb",c\r\n')).toEqual({ ok: true, rows: [['a\r\nb', 'c']] });
});

it('refuses an unbalanced or misplaced quote', () => {
  expect(readCsv('a,"b')).toMatchObject({ ok: false, code: 'bad_quote' });
  expect(readCsv('a,b"c')).toMatchObject({ ok: false, code: 'bad_quote' });
  expect(readCsv('"a"b')).toMatchObject({ ok: false, code: 'bad_quote' });
});

it('prefixes the formula starters and strips exactly one prefix', () => {
  for (const v of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) expect(escapeCell(v)).toBe(`'${v}`);
  expect(escapeCell('plain')).toBe('plain');
  expect(unescapeCell("'=1")).toBe('=1');
  expect(unescapeCell("''=1")).toBe("'=1");
  expect(unescapeCell("'plain")).toBe("'plain");
});
