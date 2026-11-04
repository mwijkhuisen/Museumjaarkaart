import type { MuseumList, MuseumListItem, MuseumListQuery } from '@mjk/contracts';
import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { decodeCursor, encodeCursor, type PageCursor } from './cursor.ts';
import { matches } from './search.ts';

// The catalogue list (A§14): filters combined with AND, keyset paging, `total` under the same filters.
// Reads only pub_museum and the search function pub_search, so it runs as mjk_api and as mjk_ssr.
//
// Order without `q`: (sort_name, id). With `q`: (tier, score descending, sort_name, id). `sort=rank`
// orders like `name` until P3a (owner decision Q2), and with `q` both values give the relevance order:
// the parameter is parsed and changes nothing yet. No OFFSET: the next page starts after the cursor's
// row, compared as one row value, so the comparison and the ORDER BY agree.

/** The cursor is malformed, or belongs to the other mode (a search cursor without `q`, or the reverse). */
export class InvalidCursor extends Error {
  constructor() {
    super('invalid_cursor');
  }
}

export type ListParams = Pick<MuseumListQuery, 'province' | 'municipality' | 'category' | 'mk' | 'limit'> & {
  q?: string | undefined;
  cursor?: string | undefined;
};

/** The cursor of this request, or InvalidCursor: checked before any SQL. */
export function resolveCursor(q: string | undefined, raw: string | undefined): PageCursor | null {
  if (raw === undefined) return null;
  const decoded = decodeCursor(raw);
  if (!decoded.ok || decoded.cursor.m !== (q === undefined ? 'n' : 's')) throw new InvalidCursor();
  return decoded.cursor;
}

type Row = Omit<MuseumListItem, 'closed_on'> & {
  closed_on: string | null;
  sort_name: string;
  tier?: 1 | 2 | 3;
  score?: number;
};

const COLUMNS = sql`m.id, m.slug, m.name, m.name_en, m.place, m.municipality_code, m.municipality_name,
  m.province_code, m.lat, m.lon, m.categories, m.museumkaart_status, m.registered, m.closed_on,
  m.temp_closed, m.sort_name`;

function filters(p: ListParams): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  if (p.province !== undefined) parts.push(sql`m.province_code = ${p.province}`);
  if (p.municipality !== undefined) parts.push(sql`m.municipality_code = ${p.municipality}`);
  if (p.category !== undefined) parts.push(sql`m.categories @> ARRAY[${p.category}]::text[]`);
  if (p.mk !== undefined) parts.push(sql`m.museumkaart_status = 'participating'`);
  return parts.length === 0 ? sql`TRUE` : sql.join(parts, sql` AND `);
}

function after(cursor: PageCursor | null): RawBuilder<unknown> {
  if (cursor === null) return sql`TRUE`;
  if (cursor.m === 'n') return sql`(m.sort_name, m.id) > (${cursor.k}::text, ${cursor.i}::uuid)`;
  return sql`(b.tier, -b.score, m.sort_name, m.id) > (${cursor.t}::int, -${cursor.s}::float8, ${cursor.k}::text, ${cursor.i}::uuid)`;
}

const item = (r: Row): MuseumListItem => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  name_en: r.name_en,
  place: r.place,
  municipality_code: r.municipality_code,
  municipality_name: r.municipality_name,
  province_code: r.province_code,
  lat: r.lat,
  lon: r.lon,
  categories: r.categories,
  museumkaart_status: r.museumkaart_status,
  registered: r.registered,
  closed_on: r.closed_on,
  temp_closed: r.temp_closed,
});

/** One page and the total. `limit + 1` rows are read to know whether another page follows. */
export async function listMuseums(db: Db, p: ListParams): Promise<MuseumList> {
  const cursor = resolveCursor(p.q, p.cursor);
  const where = filters(p);
  const { q } = p;
  return db
    .transaction()
    .setAccessMode('read only')
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      let rows: Row[];
      let total: number;
      if (q === undefined) {
        rows = (
          await sql<Row>`SELECT ${COLUMNS} FROM pub_museum m
            WHERE ${where} AND ${after(cursor)}
            ORDER BY m.sort_name, m.id LIMIT ${p.limit + 1}`.execute(trx)
        ).rows;
        const count = await sql<{ n: string }>`SELECT count(*) AS n FROM pub_museum m WHERE ${where}`.execute(trx);
        total = Number(count.rows[0]?.n ?? 0);
      } else {
        rows = (
          await sql<Row>`WITH best AS (${matches(q)})
            SELECT ${COLUMNS}, b.tier, b.score
            FROM best b JOIN pub_museum m ON m.id = b.id
            WHERE ${where} AND ${after(cursor)}
            ORDER BY b.tier, -b.score, m.sort_name, m.id LIMIT ${p.limit + 1}`.execute(trx)
        ).rows;
        const count = await sql<{ n: string }>`WITH best AS (${matches(q)})
          SELECT count(*) AS n FROM best b JOIN pub_museum m ON m.id = b.id WHERE ${where}`.execute(trx);
        total = Number(count.rows[0]?.n ?? 0);
      }
      const page = rows.slice(0, p.limit);
      const last = page.at(-1);
      const more = rows.length > p.limit && last !== undefined;
      let next: string | null = null;
      if (more) {
        next = encodeCursor(
          last.tier === undefined || last.score === undefined
            ? { m: 'n', k: last.sort_name, i: last.id }
            : { m: 's', t: last.tier, s: last.score, k: last.sort_name, i: last.id },
        );
      }
      return { items: page.map(item), next_cursor: next, total };
    });
}
