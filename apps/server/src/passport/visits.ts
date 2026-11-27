import type { Visit, VisitMuseum } from '@mjk/contracts';
import { IsoDate } from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { todayAmsterdam } from '../admin/dates.ts';
import type { Db } from '../db/kysely.ts';

// The member's visit rows as the contracts' `Visit` (A§10). Shared by the /me routes, the export and the
// progress code. The museum comes from `museum` itself, not `pub_museum`, so a museum hidden after the
// visit still shows by name, with `slug: null` and no link.

/** The earliest date a visit may carry (the migration's phase file, A§10). */
export const VISIT_MIN_DATE = '1900-01-01';

/** True when a `YYYY-MM-DD` date is a possible visit day: not in the future (Europe/Amsterdam), not before 1900. */
export const visitDateOk = (date: string): boolean => date >= VISIT_MIN_DATE && date <= todayAmsterdam();

/** `visited_on` is read as text: node-postgres would turn a `date` into a local-time `Date`. */
const COLUMNS = sql`v.id, v.visited_on::text AS visited_on, v.note, v.source, v.created_at,
  m.id AS museum_id, CASE WHEN m.hidden THEN NULL ELSE m.slug END AS slug, m.name, m.name_en, m.place`;
const FROM = sql`FROM visit v JOIN museum m ON m.id = v.museum_id`;

export type VisitRow = {
  id: string;
  visited_on: string | null;
  note: string | null;
  source: Visit['source'];
  created_at: Date;
  museum_id: string;
  slug: string | null;
  name: string;
  name_en: string | null;
  place: string | null;
};

export const toVisitMuseum = (r: Pick<VisitRow, 'museum_id' | 'slug' | 'name' | 'name_en' | 'place'>): VisitMuseum => ({
  id: r.museum_id,
  slug: r.slug,
  name: r.name,
  name_en: r.name_en,
  place: r.place,
});

export const toVisit = (r: VisitRow): Visit => ({
  id: r.id,
  museum: toVisitMuseum(r),
  visited_on: r.visited_on,
  note: r.note,
  source: r.source,
  created_at: r.created_at.toISOString(),
});

/** The member's visit by id, or undefined (another member's visit is none). */
export async function visitById(db: Db, userId: string, id: string): Promise<Visit | undefined> {
  const { rows } =
    await sql<VisitRow>`SELECT ${COLUMNS} ${FROM} WHERE v.user_id = ${userId}::uuid AND v.id = ${id}::uuid`.execute(db);
  return rows[0] === undefined ? undefined : toVisit(rows[0]);
}

/** Every visit of the member to one museum, newest first, undated last. */
export async function visitsOfMuseum(db: Db, userId: string, museumId: string): Promise<Visit[]> {
  const { rows } = await sql<VisitRow>`SELECT ${COLUMNS} ${FROM}
    WHERE v.user_id = ${userId}::uuid AND v.museum_id = ${museumId}::uuid
    ORDER BY v.visited_on DESC NULLS LAST, v.id DESC`.execute(db);
  return rows.map(toVisit);
}

// The keyset cursor: the last row's date (null for an undated one) and id. Strict, so every value that
// reaches SQL has been checked first (the 22P02 gotcha): the date is a real one from 1900 on, like every
// stored one, since PostgreSQL refuses the year 0000 (22008) and logs the value.
const PageCursor = z.strictObject({ d: IsoDate.refine((d) => d >= VISIT_MIN_DATE).nullable(), i: z.uuid() });
export class InvalidVisitCursor extends Error {
  constructor() {
    super('invalid_cursor');
  }
}

const encode = (d: string | null, i: string): string => Buffer.from(JSON.stringify({ d, i })).toString('base64url');

function decode(text: string): z.infer<typeof PageCursor> {
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new InvalidVisitCursor();
  try {
    const parsed = PageCursor.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw new InvalidVisitCursor();
}

/** One page of the member's log, newest first: `(visited_on DESC NULLS LAST, id DESC)`, like the index. */
export async function visitPage(
  db: Db,
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: Visit[]; next: string | null }> {
  let after = sql`TRUE`;
  if (cursor !== undefined) {
    const { d, i } = decode(cursor);
    after =
      d === null
        ? sql`(v.visited_on IS NULL AND v.id < ${i}::uuid)`
        : sql`(v.visited_on < ${d}::date OR (v.visited_on = ${d}::date AND v.id < ${i}::uuid) OR v.visited_on IS NULL)`;
  }
  const { rows } = await sql<VisitRow>`SELECT ${COLUMNS} ${FROM}
    WHERE v.user_id = ${userId}::uuid AND ${after}
    ORDER BY v.visited_on DESC NULLS LAST, v.id DESC LIMIT ${limit + 1}`.execute(db);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toVisit),
    next: rows.length > limit && last !== undefined ? encode(last.visited_on, last.id) : null,
  };
}
