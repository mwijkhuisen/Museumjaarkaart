import { DEFAULT_SETTINGS, IMPORT_ROWS_MAX } from '@mjk/contracts';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { parseMjk } from '../../../src/passport/import/mjk.ts';
import { MjkExportV1 } from '../../../src/passport/mjk-format.ts';

const TODAY = '2026-11-27';
const ID = '0b0f8f3e-7c1d-4a52-9d0e-2f6c1a8b4e11';
const AT = '2026-11-01T10:00:00.000Z';
const museum = (over: object = {}) => ({
  id: ID,
  slug: 'rijksmuseum',
  name: 'Rijksmuseum',
  place: 'Amsterdam',
  wikidata_qid: 'Q190804',
  ...over,
});
const doc = (over: object = {}) => ({
  format: 'mjk',
  version: 1,
  exported_at: AT,
  account: {
    handle: 'anna',
    display_name: 'Anna',
    email: 'anna@example.org',
    created_at: AT,
    email_verified_at: AT,
    age_confirmed_at: AT,
    terms_version: '2026-11',
    terms_accepted_at: AT,
    settings: DEFAULT_SETTINGS,
  },
  visits: [{ museum: museum(), visited_on: '2026-05-06', note: 'top', source: 'manual', created_at: AT }],
  wishlist: [{ museum: museum({ name: 'Mauritshuis', place: null, wikidata_qid: null }), created_at: AT }],
  sessions: [{ host: 'public', method: 'password', created_at: AT, last_used_at: AT }],
  passkeys: [{ name: 'Laptop', transports: ['internal'], backed_up: true, created_at: AT, last_used_at: null }],
  imports: [{ format: 'csv', state: 'done', created_at: AT, confirmed_at: null, rows: [{ any: 1 }] }],
  exports: [{ state: 'ready', created_at: AT, expires_at: null }],
  content_ip_log: [{ target_kind: 'review', target_id: ID, ip: '192.0.2.1', created_at: AT }],
  ...over,
});
const parse = (v: unknown) => parseMjk(JSON.stringify(v), TODAY);
const rowsOf = (v: unknown) => {
  const r = parse(v);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
};

it('round-trips an export: the schema accepts it and the parser reads its visits then wishlist', () => {
  const d = doc();
  expect(MjkExportV1.safeParse(d).success).toBe(true);
  expect(MjkExportV1.safeParse({ ...d, extra: 1 }).success).toBe(false);
  expect(rowsOf(d)).toEqual([
    {
      row: 1,
      kind: 'visit',
      ref: { mjkId: ID, qid: 'Q190804', museumnlUrl: null, name: 'Rijksmuseum', place: 'Amsterdam' },
      visited_on: '2026-05-06',
      note: 'top',
      rating: null,
      review: null,
      error: null,
    },
    {
      row: 2,
      kind: 'wishlist',
      ref: { mjkId: ID, qid: null, museumnlUrl: null, name: 'Mauritshuis', place: null },
      visited_on: null,
      note: null,
      rating: null,
      review: null,
      error: null,
    },
  ]);
});

it('refuses a file by its envelope', () => {
  expect(parseMjk('', TODAY)).toEqual({ ok: false, error: 'bad_json' });
  expect(parseMjk('{"format":', TODAY)).toEqual({ ok: false, error: 'bad_json' });
  for (const v of [null, 3, 'mjk', [], {}, { format: 'csv', version: 1 }, { version: 1 }]) {
    expect(parse(v)).toEqual({ ok: false, error: 'bad_format' });
  }
  for (const version of [0, 2, '1', null, undefined]) {
    expect(parse({ format: 'mjk', version })).toEqual({ ok: false, error: 'bad_version' });
  }
  expect(parse({ format: 'mjk', version: 1 })).toEqual({ ok: false, error: 'empty' });
  expect(parse({ format: 'mjk', version: 1, visits: 'x', wishlist: {} })).toEqual({ ok: false, error: 'empty' });
  expect(parseMjk(`﻿${JSON.stringify(doc())}`, TODAY)).toMatchObject({ ok: true });
});

it('reads only visits and wishlist, and each entry on its own', () => {
  const rows = rowsOf({
    format: 'mjk',
    version: 1,
    visits: [
      { museum: museum(), visited_on: '2026-02-30', note: null },
      { museum: museum(), visited_on: '2026-11-28', note: null },
      { museum: museum({ name: 'x'.repeat(251) }), visited_on: null, note: null },
      { museum: { id: 'nope', wikidata_qid: 'nope', name: null, place: null }, visited_on: null, note: null },
      { museum: museum(), visited_on: 20260101, note: null },
      { museum: museum(), visited_on: null, note: 7 },
      'garbage',
      null,
      { museum: museum(), visited_on: '2026-01-01', note: 'a\u{0000}b' },
      { museum: museum(), visited_on: '04-03-2026', note: ' ok ' },
    ],
    wishlist: [{ museum: museum({ name: null, id: null, wikidata_qid: null }), visited_on: '2020-01-01', note: 'n' }],
  });
  expect(rows.map((r) => [r.row, r.kind, r.error])).toEqual([
    [1, 'visit', 'bad_date'],
    [2, 'visit', 'future_date'],
    [3, 'visit', 'too_long'],
    [4, 'visit', 'no_museum'],
    [5, 'visit', 'bad_text'],
    [6, 'visit', 'bad_text'],
    [7, 'visit', 'no_museum'],
    [8, 'visit', 'no_museum'],
    [9, 'visit', 'bad_text'],
    [10, 'visit', null],
    [11, 'wishlist', 'no_museum'],
  ]);
  expect(rows[9]).toMatchObject({ visited_on: '2026-03-04', note: 'ok' });
  expect(rows[10]).toMatchObject({ visited_on: null, note: null });
  expect(rows[1]).toMatchObject({ visited_on: '2026-11-28' });
});

it('judges a future date against the given today', () => {
  const d = { format: 'mjk', version: 1, visits: [{ museum: museum(), visited_on: '2026-11-28' }] };
  expect(parseMjk(JSON.stringify(d), '2026-11-28')).toMatchObject({ ok: true, rows: [{ error: null }] });
  expect(parseMjk(JSON.stringify(d), '2026-11-27')).toMatchObject({ ok: true, rows: [{ error: 'future_date' }] });
});

it('caps visits and wishlist together at IMPORT_ROWS_MAX', () => {
  const e = { museum: museum() };
  const make = (v: number, w: number) => ({
    format: 'mjk',
    version: 1,
    visits: Array.from({ length: v }, () => e),
    wishlist: Array.from({ length: w }, () => e),
  });
  expect(parse(make(IMPORT_ROWS_MAX - 1, 1))).toMatchObject({ ok: true });
  expect(parse(make(IMPORT_ROWS_MAX, 1))).toEqual({ ok: false, error: 'too_many_rows' });
  expect(parse(make(0, IMPORT_ROWS_MAX + 1))).toEqual({ ok: false, error: 'too_many_rows' });
});

it('never throws, for any text or any near-valid document', () => {
  for (const arb of [fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' })]) {
    fc.assert(
      fc.property(arb, (s) => {
        expect(typeof parseMjk(s, TODAY).ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  }
  fc.assert(
    fc.property(
      fc.record({
        format: fc.constantFrom('mjk', 'x', 1, null),
        version: fc.constantFrom(1, 2, '1', null),
        visits: fc.array(fc.jsonValue(), { maxLength: 6 }),
        wishlist: fc.oneof(fc.array(fc.jsonValue(), { maxLength: 6 }), fc.jsonValue()),
      }),
      (v) => {
        expect(typeof parseMjk(JSON.stringify(v), TODAY).ok).toBe('boolean');
      },
    ),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          museum: fc.oneof(
            fc.jsonValue(),
            fc.record({ id: fc.jsonValue(), name: fc.jsonValue(), wikidata_qid: fc.jsonValue() }),
          ),
          visited_on: fc.oneof(fc.jsonValue(), fc.string({ unit: 'binary' })),
          note: fc.oneof(fc.jsonValue(), fc.string({ unit: 'binary' })),
        }),
        { maxLength: 8 },
      ),
      (visits) => {
        expect(typeof parse({ format: 'mjk', version: 1, visits }).ok).toBe('boolean');
      },
    ),
    { numRuns: 500 },
  );
});
