import type { MuseumList, MuseumListItem, MuseumListQuery, MuseumPoint, MuseumPoints } from '@mjk/contracts';
import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import { ASPECT_MIN } from '../reviews/score.ts';
import { decodeCursor, encodeCursor, type NameCursor, type RankCursor, type SearchCursor } from './cursor.ts';
import { matches } from './search.ts';

// The catalogue list (A§14): filters combined with AND, keyset paging, `total` under the same filters.
// Reads only pub_museum and the search function pub_search, so it runs as mjk_api and as mjk_ssr.
//
// Order without `q`: `sort=rank` (the default, P3a): (Bayesian score descending, sort_name, id), a museum
// without a museum_stats row scoring 0; `sort=name`: (sort_name, id). With `q`: (tier, score descending,
// sort_name, id), whatever `sort` says. No OFFSET: the next page starts after the cursor's row, compared
// as one row value, so the comparison and the ORDER BY agree. The scores come from the worker's recompute
// (stats-job.ts), so a recompute between two pages of a rank list can move a museum (A§14).

/** The cursor is malformed, or belongs to another mode than this request's (search, rank or name). */
export class InvalidCursor extends Error {
  constructor() {
    super('invalid_cursor');
  }
}

export type ListParams = Pick<MuseumListQuery, 'province' | 'municipality' | 'category' | 'mk' | 'limit'> & {
  q?: string | undefined;
  cursor?: string | undefined;
  /** Without `q`: `rank` (the default) or `name`; with `q` the relevance order wins. */
  sort?: MuseumListQuery['sort'] | undefined;
  min_rating?: MuseumListQuery['min_rating'] | undefined;
  kid_friendly?: MuseumListQuery['kid_friendly'] | undefined;
  /** GET /me/museums (P2c): narrow to this member's visits and wishlist; unset, the list is the public one. */
  member?: { userId: string; visited?: 'yes' | 'no' | undefined; wishlist?: 'yes' | 'no' | undefined } | undefined;
};

type ListCursor = NameCursor | RankCursor | SearchCursor;

/** The cursor of this request, or InvalidCursor: checked before any SQL. `q` wants `s`, rank `r`, name `n`. */
export function resolveCursor(
  q: string | undefined,
  sort: MuseumListQuery['sort'],
  raw: string | undefined,
): ListCursor | null {
  if (raw === undefined) return null;
  const decoded = decodeCursor(raw);
  if (!decoded.ok) throw new InvalidCursor();
  const c = decoded.cursor;
  const want = q !== undefined ? 's' : sort === 'name' ? 'n' : 'r';
  if (c.m === want && (c.m === 'n' || c.m === 'r' || c.m === 's')) return c;
  throw new InvalidCursor();
}

type Row = Omit<MuseumListItem, 'closed_on'> & {
  closed_on: string | null;
  sort_name: string;
  rank_score: number;
  tier?: 1 | 2 | 3;
  score?: number;
};

const COLUMNS = sql`m.id, m.slug, m.name, m.name_en, m.place, m.municipality_code, m.municipality_name,
  m.province_code, m.lat, m.lon, m.categories, m.museumkaart_status, m.registered, m.closed_on,
  m.temp_closed, m.sort_name, coalesce(s.rating_count, 0)::int AS rating_count, s.rating_mean,
  coalesce(s.bayes_score, 0)::float8 AS rank_score`;

/** The scores of the non-hidden museums: every query that uses `filters()` joins this as `s`. */
const STATS = sql`LEFT JOIN pub_museum_stats s ON s.museum_id = m.id`;

/** `kid_friendly=true`: a mean of at least this, from ASPECT_MIN ratings of the aspect (owner Q6). */
const KID_FRIENDLY_MEAN_MIN = 4;

/** `EXISTS` or `NOT EXISTS` of a row of the member's in `visit` or `wishlist`. */
function marked(table: 'visit' | 'wishlist', userId: string, want: 'yes' | 'no'): RawBuilder<unknown> {
  const exists = sql`EXISTS (SELECT 1 FROM ${sql.table(table)} t WHERE t.user_id = ${userId}::uuid AND t.museum_id = m.id)`;
  return want === 'yes' ? exists : sql`NOT ${exists}`;
}

function filters(p: Omit<ListParams, 'limit' | 'cursor'>): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  if (p.province !== undefined) parts.push(sql`m.province_code = ${p.province}`);
  if (p.municipality !== undefined) parts.push(sql`m.municipality_code = ${p.municipality}`);
  if (p.category !== undefined) parts.push(sql`m.categories @> ARRAY[${p.category}]::text[]`);
  if (p.mk !== undefined) parts.push(sql`m.museumkaart_status = 'participating'`);
  // The stored means are already round(avg, 1): the shown value is what the filter compares (owner Q6).
  if (p.min_rating !== undefined) {
    parts.push(sql`s.rating_count >= 1 AND s.rating_mean >= ${Number(p.min_rating)}::float8`);
  }
  if (p.kid_friendly !== undefined) {
    parts.push(
      sql`s.kid_friendly_count >= ${ASPECT_MIN}::int AND s.kid_friendly_mean >= ${KID_FRIENDLY_MEAN_MIN}::float8`,
    );
  }
  const { member } = p;
  if (member?.visited !== undefined) parts.push(marked('visit', member.userId, member.visited));
  if (member?.wishlist !== undefined) parts.push(marked('wishlist', member.userId, member.wishlist));
  return parts.length === 0 ? sql`TRUE` : sql.join(parts, sql` AND `);
}

function after(cursor: ListCursor | null): RawBuilder<unknown> {
  if (cursor === null) return sql`TRUE`;
  if (cursor.m === 'n') return sql`(m.sort_name, m.id) > (${cursor.k}::text, ${cursor.i}::uuid)`;
  if (cursor.m === 'r') {
    return sql`(-coalesce(s.bayes_score, 0), m.sort_name, m.id) > (-${cursor.s}::float8, ${cursor.k}::text, ${cursor.i}::uuid)`;
  }
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
  rating_count: r.rating_count,
  rating_mean: r.rating_mean,
});

/** Every visible museum with coordinates that the filters match: the map's points, ordered by id. */
export async function listPoints(db: Db, p: Omit<ListParams, 'limit' | 'cursor'>): Promise<MuseumPoints> {
  const where = filters(p);
  const { q } = p;
  const cols = sql`m.id, m.slug, m.name, m.name_en, m.lat, m.lon, m.museumkaart_status, m.categories`;
  const { rows } = await db
    .transaction()
    .setAccessMode('read only')
    .execute((trx) =>
      q === undefined
        ? sql<MuseumPoint>`SELECT ${cols} FROM pub_museum m ${STATS}
            WHERE ${where} AND m.lat IS NOT NULL AND m.lon IS NOT NULL ORDER BY m.id`.execute(trx)
        : sql<MuseumPoint>`WITH best AS (${matches(q)})
            SELECT ${cols} FROM best b JOIN pub_museum m ON m.id = b.id ${STATS}
            WHERE ${where} AND m.lat IS NOT NULL AND m.lon IS NOT NULL ORDER BY m.id`.execute(trx),
    );
  return { items: rows };
}

/** One page and the total. `limit + 1` rows are read to know whether another page follows. */
export async function listMuseums(db: Db, p: ListParams): Promise<MuseumList> {
  const sort = p.sort ?? 'rank';
  const cursor = resolveCursor(p.q, sort, p.cursor);
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
        const order =
          sort === 'name' ? sql`m.sort_name, m.id` : sql`coalesce(s.bayes_score, 0) DESC, m.sort_name, m.id`;
        rows = (
          await sql<Row>`SELECT ${COLUMNS} FROM pub_museum m ${STATS}
            WHERE ${where} AND ${after(cursor)}
            ORDER BY ${order} LIMIT ${p.limit + 1}`.execute(trx)
        ).rows;
        const count = await sql<{ n: string }>`SELECT count(*) AS n FROM pub_museum m ${STATS}
          WHERE ${where}`.execute(trx);
        total = Number(count.rows[0]?.n ?? 0);
      } else {
        rows = (
          await sql<Row>`WITH best AS (${matches(q)})
            SELECT ${COLUMNS}, b.tier, b.score
            FROM best b JOIN pub_museum m ON m.id = b.id ${STATS}
            WHERE ${where} AND ${after(cursor)}
            ORDER BY b.tier, -b.score, m.sort_name, m.id LIMIT ${p.limit + 1}`.execute(trx)
        ).rows;
        const count = await sql<{ n: string }>`WITH best AS (${matches(q)})
          SELECT count(*) AS n FROM best b JOIN pub_museum m ON m.id = b.id ${STATS}
          WHERE ${where}`.execute(trx);
        total = Number(count.rows[0]?.n ?? 0);
      }
      const page = rows.slice(0, p.limit);
      const last = page.at(-1);
      const more = rows.length > p.limit && last !== undefined;
      let next: string | null = null;
      if (more) {
        if (last.tier !== undefined && last.score !== undefined) {
          next = encodeCursor({ m: 's', t: last.tier, s: last.score, k: last.sort_name, i: last.id });
        } else if (sort === 'name') {
          next = encodeCursor({ m: 'n', k: last.sort_name, i: last.id });
        } else {
          next = encodeCursor({ m: 'r', s: last.rank_score, k: last.sort_name, i: last.id });
        }
      }
      return { items: page.map(item), next_cursor: next, total };
    });
}
