import type { Progress } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';

// Progress against the Museumkaart list (A§10, P2c): pure `progressOf` over visit rows, and two loaders that
// differ only in where the rows come from. Only visible museums count (both loaders join `pub_museum`).
// Membership is `mk_list_member` (the newest published version's members) and N is the published N, never
// today's flags: flipping a member's status after publication changes neither (A§7.5).

/** One visit (or one museum-month of the public log): the year is null for an undated visit. */
export type ProgressRow = {
  museum_id: string;
  year: number | null;
  mk_list_member: boolean;
  province_code: string | null;
};

export type ListInfo = { published_on: string; n: number } | null;
export type ProvinceN = { code: string | null; n: number };

type ProvinceCode = NonNullable<Progress['list']>['provinces'][number]['code'];

export function progressOf(rows: readonly ProgressRow[], list: ListInfo, provinces: readonly ProvinceN[]): Progress {
  const all = new Set<string>();
  const members = new Map<string, string | null>(); // listed museum -> its province
  const perYear = new Map<number, Set<string>>();
  for (const r of rows) {
    all.add(r.museum_id);
    if (r.mk_list_member) members.set(r.museum_id, r.province_code);
    if (r.year !== null) {
      const set = perYear.get(r.year) ?? new Set<string>();
      set.add(r.museum_id);
      perYear.set(r.year, set);
    }
  }
  const years = [...perYear].map(([year, set]) => ({ year, museums: set.size })).sort((a, b) => b.year - a.year);
  if (list === null) return { list: null, all_time: all.size, years };

  const visitedIn = new Map<string | null, number>();
  for (const code of members.values()) visitedIn.set(code, (visitedIn.get(code) ?? 0) + 1);
  return {
    list: {
      published_on: list.published_on,
      n: list.n,
      visited: members.size,
      // By code, the null one last: the same input is always the same answer.
      provinces: [...provinces]
        .sort((a, b) => (a.code === b.code ? 0 : a.code === null ? 1 : b.code === null ? -1 : a.code < b.code ? -1 : 1))
        .map((p) => ({ code: p.code as ProvinceCode, n: p.n, visited: visitedIn.get(p.code) ?? 0 })),
    },
    all_time: all.size,
    years,
  };
}

/** The published list's date and N, and each province's N (hidden museums included, so they add up to N). */
async function reference(db: Db): Promise<{ list: ListInfo; provinces: ProvinceN[] }> {
  // Dates are cast to text here and below: a `date` is never a JS Date, whatever the pool's type parsers do.
  const l = await db
    .selectFrom('pub_mk_list')
    .select([sql<string | null>`published_on::text`.as('published_on'), 'n'])
    .executeTakeFirst();
  const list: ListInfo =
    l === undefined || l.published_on === null || l.n === null
      ? null
      : { published_on: l.published_on, n: Number(l.n) };
  const p = await db.selectFrom('pub_mk_list_province').select(['province_code', 'n']).execute();
  return { list, provinces: p.map((r) => ({ code: r.province_code, n: Number(r.n) })) };
}

/** `period` is a date (`YYYY-MM-DD`) or a month (`YYYY-MM`); only its year is read. */
type DbRow = { museum_id: string; period: string | null; mk_list_member: boolean | null; province_code: string | null };

async function progress(db: Db, rows: readonly DbRow[]): Promise<Progress> {
  const ref = await reference(db);
  return progressOf(
    rows.map((r) => ({
      museum_id: r.museum_id,
      year: r.period === null ? null : Number(r.period.slice(0, 4)),
      mk_list_member: r.mk_list_member === true,
      province_code: r.province_code,
    })),
    ref.list,
    ref.provinces,
  );
}

/** The member's own progress: every visit, no delay (as `mjk_api`). */
export async function memberProgress(db: Db, userId: string): Promise<Progress> {
  const rows = await db
    .selectFrom('visit as v')
    .innerJoin('pub_museum as m', 'm.id', 'v.museum_id')
    .select(['v.museum_id', sql<string | null>`v.visited_on::text`.as('period'), 'm.mk_list_member', 'm.province_code'])
    .where('v.user_id', '=', userId)
    .execute();
  return progress(db, rows);
}

/**
 * A member's public progress, from `pub_visit_log(handle)`, so Q1's 24 h delay and the visibility setting hold.
 * Works as `mjk_ssr` (it reads only `pub_*` views and that function). The caller asks only when the log is public.
 */
export async function publicProgress(db: Db, handle: string): Promise<Progress> {
  const { rows } = await sql<DbRow>`
    SELECT l.museum_id, l.visited_month AS period, m.mk_list_member, m.province_code
      FROM pub_visit_log(${handle}) l
      JOIN pub_museum m ON m.id = l.museum_id`.execute(db);
  return progress(db, rows);
}
