// What both import parsers (CSV and `mjk`) produce (A§10): one ParsedRow per data row, with the
// row's own error instead of a file error, so one bad row never sinks the file. Server-internal.

import { isStorable, VISIT_NOTE_MAX } from '@mjk/contracts';
import { parseDate } from '../../admin/dates.ts';
import { museumnlUrl as checkMuseumnlUrl } from '../../museums/museumnl.ts';

export type RowError = 'bad_date' | 'future_date' | 'no_museum' | 'too_long' | 'bad_text';
export type MuseumRef = {
  mjkId: string | null;
  qid: string | null;
  museumnlUrl: string | null;
  name: string | null;
  place: string | null;
};
export type ParsedRow = {
  row: number;
  kind: 'visit' | 'wishlist';
  ref: MuseumRef;
  visited_on: string | null;
  note: string | null;
  error: RowError | null;
};
export type FileError =
  | 'bad_quote'
  | 'no_header'
  | 'bad_header'
  | 'too_many_rows'
  | 'empty'
  | 'bad_json'
  | 'bad_format'
  | 'bad_version';
export type ParseResult = { ok: true; rows: ParsedRow[] } | { ok: false; error: FileError };

const NAME_MAX = 250;
const QID_RE = /^Q[1-9][0-9]{0,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_FIRST = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const DATE_LAST = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
const EARLIEST = '1900-01-01';

/** One cell as trimmed text, empty as null. */
export const cellOrNull = (s: string): string | null => {
  const t = s.trim();
  return t === '' ? null : t;
};

/** `YYYY-MM-DD`, `DD-MM-YYYY` or `D-M-YYYY` (also with `/`) as a real calendar day, else undefined. */
export function normaliseDate(text: string): string | undefined {
  const first = DATE_FIRST.exec(text);
  const last = first ? null : DATE_LAST.exec(text);
  const [y, m, d] = first ? [first[1], first[2], first[3]] : last ? [last[3], last[2], last[1]] : [];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  return parseDate(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
}

export type RawRow = {
  row: number;
  kind: 'visit' | 'wishlist';
  mjkId: string | null;
  qid: string | null;
  museumnlUrl: string | null;
  name: string | null;
  place: string | null;
  date: string | null;
  note: string | null;
};

/** The same text, length, museum and date rules for both formats (cells already trimmed, empty as null). */
export function toRow(raw: RawRow, today: string): ParsedRow {
  const { row, kind, mjkId, qid, museumnlUrl, name, place, date, note } = raw;
  const ref: MuseumRef = {
    mjkId: mjkId !== null && UUID_RE.test(mjkId) ? mjkId : null,
    qid: qid !== null && QID_RE.test(qid) ? qid : null,
    museumnlUrl: museumnlUrl === null ? null : (checkMuseumnlUrl(museumnlUrl) ?? null),
    name,
    place,
  };
  const parsedDate = date === null ? null : (normaliseDate(date) ?? undefined);
  const validDate = parsedDate != null && parsedDate >= EARLIEST ? parsedDate : null;
  let error: RowError | null = null;
  if (![mjkId, qid, museumnlUrl, name, place, date, note].every((c) => c === null || isStorable(c))) error = 'bad_text';
  else if ((name?.length ?? 0) > NAME_MAX || (place?.length ?? 0) > NAME_MAX || (note?.length ?? 0) > VISIT_NOTE_MAX) {
    error = 'too_long';
  } else if (!ref.mjkId && !ref.qid && !ref.museumnlUrl && name === null) error = 'no_museum';
  else if (parsedDate === undefined || (parsedDate !== null && validDate === null)) error = 'bad_date';
  else if (validDate !== null && validDate > today) error = 'future_date';
  // A row error keeps what parsed, never text that cannot be stored (jsonb refuses a NUL) or shown
  // (the preview contract caps the lengths): such a field comes back null.
  const keep = (s: string | null, max: number) => (s !== null && isStorable(s) && s.length <= max ? s : null);
  return {
    row,
    kind,
    ref: { ...ref, name: keep(name, NAME_MAX), place: keep(place, NAME_MAX) },
    visited_on: validDate,
    note: keep(note, VISIT_NOTE_MAX),
    error,
  };
}
