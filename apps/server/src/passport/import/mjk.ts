// The `mjk` import (A§10): our own export.json read back. Lenient on purpose: only `visits` and
// `wishlist` are read, each entry on its own, so one bad entry is a row error and never a file error.
// Pure and never throws; the caller passes today's date.

import { IMPORT_ROWS_MAX } from '@mjk/contracts';
import { cellOrNull, type ParsedRow, type ParseResult, type RawRow, toRow } from './types.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// A value of the wrong type becomes a text no rule accepts (a number is not a date), never a throw.
const text = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? cellOrNull(v) : '\u0000');

function entry(row: number, kind: RawRow['kind'], e: unknown, today: string): ParsedRow {
  const o = isObject(e) ? e : {};
  const m = isObject(o.museum) ? o.museum : {};
  return toRow(
    {
      row,
      kind,
      mjkId: text(m.id),
      qid: text(m.wikidata_qid),
      museumnlUrl: null,
      name: text(m.name),
      place: text(m.place),
      date: kind === 'visit' ? text(o.visited_on) : null,
      note: kind === 'visit' ? text(o.note) : null,
    },
    today,
  );
}

export function parseMjk(input: string, today: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
  } catch {
    return { ok: false, error: 'bad_json' };
  }
  if (!isObject(json) || json.format !== 'mjk') return { ok: false, error: 'bad_format' };
  if (json.version !== 1) return { ok: false, error: 'bad_version' };
  const visits = list(json.visits);
  const wishlist = list(json.wishlist);
  if (visits.length + wishlist.length > IMPORT_ROWS_MAX) return { ok: false, error: 'too_many_rows' };
  const rows = [
    ...visits.map((e, i) => entry(i + 1, 'visit', e, today)),
    ...wishlist.map((e, i) => entry(visits.length + i + 1, 'wishlist', e, today)),
  ];
  return rows.length === 0 ? { ok: false, error: 'empty' } : { ok: true, rows };
}
