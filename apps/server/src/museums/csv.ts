// Our own RFC 4180 reader and writer (plan §2.6): no dependency. CRLF line ends, quoted fields with
// doubled quotes and embedded line breaks, an optional UTF-8 BOM on input.

const NEEDS_QUOTES = /["\r\n,]/;

const quote = (field: string) => (NEEDS_QUOTES.test(field) ? `"${field.replaceAll('"', '""')}"` : field);

export const writeCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => `${row.map(quote).join(',')}\r\n`).join('');

export type CsvResult = { ok: true; rows: string[][] } | { ok: false; code: 'bad_quote'; line: number };

export function readCsv(input: string): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false; // a closing quote was just read: only , CR LF or the end may follow
  let started = false; // something of the current row has been read
  let line = 1;
  const endField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    started = true;
    if (c === ',') endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
    } else if (c === '"') {
      // A quote opens a field only at its start; anywhere else the file is malformed.
      if (field !== '' || afterQuote) return { ok: false, code: 'bad_quote', line };
      inQuotes = true;
    } else if (afterQuote) return { ok: false, code: 'bad_quote', line };
    else field += c;
  }
  if (inQuotes) return { ok: false, code: 'bad_quote', line };
  if (started) endRow();
  return { ok: true, rows };
}

// Spreadsheet formula injection: Wikidata names are untrusted, so a cell that a spreadsheet would
// run as a formula gets a leading apostrophe. The pattern allows apostrophes already there, so the
// round trip is exact for any string.
const FORMULA = /^'*[=+\-@\t\r]/;

export const escapeCell = (v: string): string => (FORMULA.test(v) ? `'${v}` : v);

/** Strips one prefix that escapeCell added. */
export const unescapeCell = (v: string): string => (FORMULA.test(v) && v.startsWith("'") ? v.slice(1) : v);
