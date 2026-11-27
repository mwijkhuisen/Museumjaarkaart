// The CSV import (A§10): our own export's visits.csv, a spreadsheet of the member's own, or a list
// copied from elsewhere. Every row is a visit. Pure and never throws; the caller passes today's date.

import { IMPORT_ROWS_MAX } from '@mjk/contracts';
import { readCsv, unescapeCell } from '../../museums/csv.ts';
import { cellOrNull, type ParsedRow, type ParseResult, toRow } from './types.ts';

// Blank lines that spreadsheets append do not count against the row cap, within reason.
const BLANK_SLACK = 100;

const ALIASES = {
  name: ['museum', 'naam', 'name', 'museumnaam', 'museum_name'],
  place: ['plaats', 'place', 'city', 'stad', 'woonplaats'],
  date: ['datum', 'date', 'bezocht', 'bezoekdatum', 'visit_date', 'visited_on'],
  note: ['notitie', 'notities', 'opmerking', 'note', 'notes'],
  qid: ['wikidata', 'qid', 'wikidata_qid'],
  url: ['museumnl', 'museum.nl', 'museumnl_url'],
  id: ['museum_id'],
} as const;
type Column = keyof typeof ALIASES;
const COLUMN_OF = new Map<string, Column>(
  (Object.keys(ALIASES) as Column[]).flatMap((col) => ALIASES[col].map((a): [string, Column] => [a, col])),
);

/** Dutch Excel writes `;`: the header line decides, counting outside quotes. */
function delimiterOf(text: string): ',' | ';' {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if (c === '\n' || c === '\r') break;
      if (c === ',') commas++;
      else if (c === ';') semis++;
    }
  }
  return semis > commas ? ';' : ',';
}

export function parseCsv(input: string, today: string): ParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const read = readCsv(text, { delimiter: delimiterOf(text), maxRows: IMPORT_ROWS_MAX + 1 + BLANK_SLACK });
  if (!read.ok) return { ok: false, error: read.code };
  const [header, ...body] = read.rows;
  if (header === undefined) return { ok: false, error: 'no_header' };

  const at: Partial<Record<Column, number>> = {};
  for (const [i, h] of header.entries()) {
    const col = COLUMN_OF.get(h.trim().toLowerCase());
    if (col === undefined) continue; // unknown columns are ignored
    if (at[col] !== undefined) return { ok: false, error: 'bad_header' };
    at[col] = i;
  }
  if (at.name === undefined && at.qid === undefined && at.url === undefined && at.id === undefined) {
    return { ok: false, error: 'bad_header' };
  }

  const rows: ParsedRow[] = [];
  for (const cells of body) {
    if (cells.every((c) => c.trim() === '')) continue;
    if (rows.length >= IMPORT_ROWS_MAX) return { ok: false, error: 'too_many_rows' };
    const get = (col: Column): string | null => {
      const i = at[col];
      const cell = i === undefined ? undefined : cells[i];
      return cell === undefined ? null : cellOrNull(unescapeCell(cell));
    };
    rows.push(
      toRow(
        {
          row: rows.length + 1,
          kind: 'visit',
          mjkId: get('id'),
          qid: get('qid'),
          museumnlUrl: get('url'),
          name: get('name'),
          place: get('place'),
          date: get('date'),
          note: get('note'),
        },
        today,
      ),
    );
  }
  return rows.length === 0 ? { ok: false, error: 'empty' } : { ok: true, rows };
}
