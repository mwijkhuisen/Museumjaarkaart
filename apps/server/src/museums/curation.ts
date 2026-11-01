import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { formatInstant, parseDate, parseInstantMs, startOfDayMs, todayAmsterdam } from '../admin/dates.ts';
import type { Db } from '../db/kysely.ts';
import type { DB } from '../db/types.ts';
import { escapeCell, readCsv, unescapeCell, writeCsv } from './csv.ts';
import { MUSEUMKAART_STATUSES, PHOTO_POLICIES, QID } from './fields.ts';

// The owner's curation of the museum catalogue (A§7.5, plan §2.6): the Museumkaart flag, the price,
// the bulk CSV and the frozen list. Everything here writes as `mjk_api`, one transaction per call,
// and every changed column leaves a `museum_change` row (origin 'admin', state 'applied').

export const EXIT_USAGE = 64;
export const EXIT_DATA = 65;
export const EXIT_NOT_FOUND = 66;

/** A failure with a fixed code and the exit code the CLI maps it to. The message is the code. */
export class AdminError extends Error {
  readonly code: string;
  readonly exit: number;
  constructor(exit: number, code: string) {
    super(code);
    this.exit = exit;
    this.code = code;
  }
}

type Trx = Transaction<DB>;

/** The editable curated columns, in CSV order. Timestamps are milliseconds, dates `YYYY-MM-DD`. */
export const EDITABLE = [
  'museumkaart_status',
  'mk_since',
  'mk_until',
  'mk_last_verified_at',
  'admission_adult_cents',
  'price_verified_at',
  'photo_policy',
  'closed_on',
  'temp_closed',
  'temp_closed_until',
  'hidden',
] as const;
export type Editable = (typeof EDITABLE)[number];

export type Curated = {
  museumkaart_status: string;
  mk_since: string | null;
  mk_until: string | null;
  mk_last_verified_at: number | null;
  admission_adult_cents: number | null;
  price_verified_at: number | null;
  photo_policy: string;
  closed_on: string | null;
  temp_closed: boolean;
  temp_closed_until: string | null;
  hidden: boolean;
};

export type MuseumRow = { id: string; wikidata_qid: string | null; slug: string; name: string; cur: Curated };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type DbRow = {
  id: string;
  wikidata_qid: string | null;
  slug: string;
  name: string;
  museumkaart_status: string;
  mk_since: string | null;
  mk_until: string | null;
  mk_last_verified_at: Date | null;
  admission_adult_cents: number | null;
  price_verified_at: Date | null;
  photo_policy: string;
  closed_on: string | null;
  temp_closed: boolean;
  temp_closed_until: string | null;
  hidden: boolean;
};

const toRow = (r: DbRow): MuseumRow => ({
  id: r.id,
  wikidata_qid: r.wikidata_qid,
  slug: r.slug,
  name: r.name,
  cur: {
    museumkaart_status: r.museumkaart_status,
    mk_since: r.mk_since,
    mk_until: r.mk_until,
    mk_last_verified_at: r.mk_last_verified_at?.getTime() ?? null,
    admission_adult_cents: r.admission_adult_cents,
    price_verified_at: r.price_verified_at?.getTime() ?? null,
    photo_policy: r.photo_policy,
    closed_on: r.closed_on,
    temp_closed: r.temp_closed,
    temp_closed_until: r.temp_closed_until,
    hidden: r.hidden,
  },
});

const selectMuseums = (trx: Trx) =>
  trx
    .selectFrom('museum')
    .select([
      'id',
      'wikidata_qid',
      'slug',
      'name',
      'museumkaart_status',
      'mk_since',
      'mk_until',
      'mk_last_verified_at',
      'admission_adult_cents',
      'price_verified_at',
      'photo_policy',
      'closed_on',
      'temp_closed',
      'temp_closed_until',
      'hidden',
    ]);

/** A QID, a uuid or a slug. The shape is checked before SQL, so a bad reference never reaches a cast. */
export async function findMuseum(trx: Trx, ref: string): Promise<MuseumRow> {
  const column = QID.test(ref) ? 'wikidata_qid' : UUID.test(ref) ? 'id' : SLUG.test(ref) ? 'slug' : undefined;
  if (column === undefined) throw new AdminError(EXIT_NOT_FOUND, 'museum_not_found');
  const row = await selectMuseums(trx).where(column, '=', ref).forUpdate().executeTakeFirst();
  if (row === undefined) throw new AdminError(EXIT_NOT_FOUND, 'museum_not_found');
  return toRow(row);
}

// --- patches -------------------------------------------------------------------------------------

const asJson = (field: Editable, v: string | number | boolean | null): string | number | boolean | null =>
  field === 'mk_last_verified_at' || field === 'price_verified_at'
    ? v === null
      ? null
      : new Date(v as number).toISOString()
    : v;

/** The table's CHECKs, repeated so that a dry run and the report can name them. */
function checkFailed(c: Curated): boolean {
  if (c.mk_since !== null && c.mk_until !== null && c.mk_until < c.mk_since) return true;
  if (c.museumkaart_status === 'left' && c.mk_until === null) return true;
  if (c.temp_closed_until !== null && !c.temp_closed) return true;
  if (c.admission_adult_cents !== null && (c.admission_adult_cents < 0 || c.admission_adult_cents > 20000)) return true;
  return false;
}

/** The columns of `patch` that differ from `before`. */
export const diffPatch = (before: Curated, patch: Partial<Curated>): Editable[] =>
  EDITABLE.filter((f) => patch[f] !== undefined && patch[f] !== before[f]);

/** Writes the changed columns and one museum_change per column. Returns the changed fields. */
async function applyPatch(trx: Trx, id: string, before: Curated, patch: Partial<Curated>): Promise<Editable[]> {
  const changed = diffPatch(before, patch);
  if (changed.length === 0) return changed;
  if (checkFailed({ ...before, ...patch })) throw new AdminError(EXIT_DATA, 'check_failed');
  const set: Record<string, unknown> = {};
  for (const f of changed) {
    const v = patch[f] as string | number | boolean | null;
    set[f] = (f === 'mk_last_verified_at' || f === 'price_verified_at') && v !== null ? new Date(v as number) : v;
  }
  try {
    await trx.updateTable('museum').set(set).where('id', '=', id).execute();
    for (const f of changed) {
      const json = (v: string | number | boolean | null) => (v === null ? null : sql`${JSON.stringify(v)}::jsonb`);
      await trx
        .insertInto('museum_change')
        .values({
          museum_id: id,
          field: f,
          old: json(asJson(f, before[f])) as never,
          new: json(asJson(f, patch[f] as string | number | boolean | null)) as never,
          origin: 'admin',
          state: 'applied',
          decided_at: sql<Date>`now()`,
        })
        .execute();
    }
  } catch (err) {
    if ((err as { code?: unknown }).code === '23514') throw new AdminError(EXIT_DATA, 'check_failed');
    throw err;
  }
  return changed;
}

export type Summary = { slug: string; name: string; changed: Editable[] };

const summary = (m: MuseumRow, changed: Editable[]): Summary => ({ slug: m.slug, name: m.name, changed });

/** `verified` is a `YYYY-MM-DD` already validated; the default is now. */
const verifiedMs = (verified: string | undefined): number =>
  verified === undefined ? Date.now() : startOfDayMs(verified);

export type FlagOptions = { since?: string; until?: string; verified?: string };

export async function flagMuseum(db: Db, ref: string, status: string, opts: FlagOptions): Promise<Summary> {
  if (!(MUSEUMKAART_STATUSES as readonly string[]).includes(status)) throw new AdminError(EXIT_USAGE, 'bad_status');
  if (status === 'left' && opts.until === undefined) throw new AdminError(EXIT_USAGE, 'left_needs_until');
  for (const d of [opts.since, opts.until, opts.verified]) {
    if (d !== undefined && parseDate(d) === undefined) throw new AdminError(EXIT_USAGE, 'bad_date');
  }
  return db.transaction().execute(async (trx) => {
    const m = await findMuseum(trx, ref);
    const patch: Partial<Curated> = { museumkaart_status: status, mk_last_verified_at: verifiedMs(opts.verified) };
    if (opts.since !== undefined) patch.mk_since = opts.since;
    if (opts.until !== undefined) patch.mk_until = opts.until;
    const final = { ...m.cur, ...patch };
    if (final.mk_since !== null && final.mk_until !== null && final.mk_until < final.mk_since) {
      throw new AdminError(EXIT_DATA, 'until_before_since');
    }
    return summary(m, await applyPatch(trx, m.id, m.cur, patch));
  });
}

export const MAX_PRICE_CENTS = 20000;

export async function priceMuseum(db: Db, ref: string, price: number | null, verified?: string): Promise<Summary> {
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > MAX_PRICE_CENTS)) {
    throw new AdminError(EXIT_DATA, 'bad_price');
  }
  if (verified !== undefined && parseDate(verified) === undefined) throw new AdminError(EXIT_USAGE, 'bad_date');
  return db.transaction().execute(async (trx) => {
    const m = await findMuseum(trx, ref);
    const patch = { admission_adult_cents: price, price_verified_at: verifiedMs(verified) };
    return summary(m, await applyPatch(trx, m.id, m.cur, patch));
  });
}

// --- CSV export and import -----------------------------------------------------------------------

export const READ_ONLY_COLUMNS = ['id', 'wikidata_qid', 'slug', 'name', 'place'] as const;
export const HEADER: readonly string[] = [...READ_ONLY_COLUMNS, ...EDITABLE];

const cellOf = (f: Editable, v: string | number | boolean | null): string => {
  if (v === null) return '';
  if (f === 'mk_last_verified_at' || f === 'price_verified_at') return formatInstant(v as number);
  return String(v);
};

export async function exportRows(db: Db): Promise<string[][]> {
  const rows = await db.transaction().execute(async (trx) => {
    const list = await selectMuseums(trx).select('place').orderBy('slug').execute();
    return list.map((r) => ({ ...toRow(r), place: r.place }));
  });
  return [
    [...HEADER],
    ...rows.map((m) => [
      escapeCell(m.id),
      escapeCell(m.wikidata_qid ?? ''),
      escapeCell(m.slug),
      escapeCell(m.name),
      escapeCell(m.place ?? ''),
      ...EDITABLE.map((f) => cellOf(f, m.cur[f])),
    ]),
  ];
}

export const exportCsv = async (db: Db): Promise<string> => writeCsv(await exportRows(db));

const empty = z.literal('').transform((): null => null);
const opt = <T extends z.ZodType>(s: T) => z.union([empty, s]);
const date = z.string().refine((s) => parseDate(s) !== undefined);
const instant = z
  .string()
  .refine((s) => parseInstantMs(s) !== undefined)
  .transform((s) => parseInstantMs(s) as number);
const cents = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,4})$/)
  .transform(Number)
  .refine((n) => n <= MAX_PRICE_CENTS);
const bool = z.enum(['true', 'false']).transform((s) => s === 'true');

const rowSchema = z.strictObject({
  id: z.string().regex(UUID),
  wikidata_qid: opt(z.string().regex(QID)),
  slug: z.string(),
  name: z.string(),
  place: z.string(),
  museumkaart_status: z.enum(MUSEUMKAART_STATUSES),
  mk_since: opt(date),
  mk_until: opt(date),
  mk_last_verified_at: opt(instant),
  admission_adult_cents: opt(cents),
  price_verified_at: opt(instant),
  photo_policy: z.enum(PHOTO_POLICIES),
  closed_on: opt(date),
  temp_closed: bool,
  temp_closed_until: opt(date),
  hidden: bool,
});

export type ImportIssue = { row: number; column: string; code: string };
export type ImportReport = { rows: number; changedRows: number; counts: Partial<Record<Editable, number>> };

/** Every issue of a refused file, in file order. The cell values are never part of it. */
export class ImportRefused extends AdminError {
  readonly issues: readonly ImportIssue[];
  constructor(issues: readonly ImportIssue[]) {
    super(EXIT_DATA, 'import_refused');
    this.issues = issues;
  }
}

const MAX_ISSUES = 50;

/**
 * Parses and checks the whole file, then writes only the changed cells in one transaction.
 * Any issue refuses the file and nothing is written. With `dryRun` the transaction is READ ONLY.
 */
export async function importCsv(db: Db, text: string, dryRun: boolean): Promise<ImportReport> {
  const parsed = readCsv(text);
  if (!parsed.ok) throw new ImportRefused([{ row: parsed.line, column: '', code: parsed.code }]);
  const [header, ...body] = parsed.rows;
  if (header === undefined || header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i])) {
    throw new ImportRefused([{ row: 1, column: '', code: 'bad_header' }]);
  }
  const issues: ImportIssue[] = [];
  const parsedRows: { row: number; value: z.output<typeof rowSchema> }[] = [];
  const seen = new Set<string>();
  body.forEach((cells, i) => {
    const row = i + 2;
    if (cells.length !== HEADER.length) {
      issues.push({ row, column: '', code: 'bad_row_length' });
      return;
    }
    const raw: Record<string, string> = {};
    HEADER.forEach((col, j) => {
      const cell = cells[j] as string;
      raw[col] = (READ_ONLY_COLUMNS as readonly string[]).includes(col) ? unescapeCell(cell) : cell;
    });
    const result = rowSchema.safeParse(raw);
    if (!result.success) {
      const cols = new Set(result.error.issues.map((is) => String(is.path[0] ?? '')));
      for (const column of cols) issues.push({ row, column, code: 'invalid' });
      return;
    }
    if (seen.has(result.data.id)) {
      issues.push({ row, column: 'id', code: 'duplicate_id' });
      return;
    }
    seen.add(result.data.id);
    parsedRows.push({ row, value: result.data });
  });
  if (issues.length > 0) throw new ImportRefused(issues.slice(0, MAX_ISSUES));

  const counts: Partial<Record<Editable, number>> = {};
  let changedRows = 0;
  const work = async (trx: Trx) => {
    const ids = parsedRows.map((r) => r.value.id);
    const found = new Map<string, MuseumRow>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of await selectMuseums(trx).where('id', 'in', chunk).execute()) found.set(r.id, toRow(r));
    }
    const plan: { m: MuseumRow; patch: Partial<Curated> }[] = [];
    for (const { row, value } of parsedRows) {
      const m = found.get(value.id);
      if (m === undefined) {
        issues.push({ row, column: 'id', code: 'unknown_id' });
        continue;
      }
      // The id and the QID must belong to the same row: a shifted row fails here.
      if (m.wikidata_qid !== value.wikidata_qid) {
        issues.push({ row, column: 'wikidata_qid', code: 'qid_mismatch' });
        continue;
      }
      const patch: Partial<Curated> = {};
      for (const f of EDITABLE) (patch as Record<string, unknown>)[f] = value[f];
      if (checkFailed({ ...m.cur, ...patch })) {
        issues.push({ row, column: '', code: 'check_failed' });
        continue;
      }
      plan.push({ m, patch });
    }
    if (issues.length > 0) throw new ImportRefused(issues.slice(0, MAX_ISSUES));
    for (const { m, patch } of plan) {
      const changed = dryRun ? diffPatch(m.cur, patch) : await applyPatch(trx, m.id, m.cur, patch);
      if (changed.length > 0) changedRows++;
      for (const f of changed) counts[f] = (counts[f] ?? 0) + 1;
    }
  };
  const tx = db.transaction();
  await (dryRun ? tx.setAccessMode('read only') : tx).execute(work);
  return { rows: parsedRows.length, changedRows, counts };
}

// --- the frozen Museumkaart list -----------------------------------------------------------------

export type PublishResult = { n: number; publishedOn: string };

/** Copies the participating, visible museums into a new version. N is later the count of its members. */
export async function publishList(db: Db, date?: string): Promise<PublishResult> {
  if (date !== undefined && parseDate(date) === undefined) throw new AdminError(EXIT_USAGE, 'bad_date');
  const publishedOn = date ?? todayAmsterdam();
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('mk_list_version')
      .select('id')
      .where('published_on', '=', publishedOn)
      .executeTakeFirst();
    if (existing !== undefined) throw new AdminError(EXIT_DATA, 'list_exists');
    let versionId: string;
    try {
      const v = await trx
        .insertInto('mk_list_version')
        .values({ published_on: publishedOn })
        .returning('id')
        .executeTakeFirstOrThrow();
      versionId = v.id;
    } catch (err) {
      if ((err as { code?: unknown }).code === '23505') throw new AdminError(EXIT_DATA, 'list_exists');
      throw err;
    }
    // N is the number of members this statement copies; an empty list rolls the version back.
    const copied = await sql`insert into mk_list_member (list_version_id, museum_id)
      select ${versionId}::uuid, id from museum where museumkaart_status = 'participating' and not hidden`.execute(trx);
    const n = Number(copied.numAffectedRows ?? 0n);
    if (n === 0) throw new AdminError(EXIT_DATA, 'list_empty');
    return { n, publishedOn };
  });
}

/** N and its date from the view, or undefined when nothing has been published. */
export async function showList(db: Db): Promise<PublishResult | undefined> {
  const row = await db.selectFrom('mk_list').select(['n', 'published_on']).executeTakeFirst();
  if (row === undefined || row.n === null || row.published_on === null) return undefined;
  return { n: Number(row.n), publishedOn: row.published_on };
}
