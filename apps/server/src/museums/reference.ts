import type { Db } from '../db/kysely.ts';

// Reference data for the public API and the server rendering (P1c): the provinces and the Museumkaart
// list version. Reads only the pub_* views, so the same functions work as mjk_api and as mjk_ssr.

export type ProvinceRow = { code: string; name_nl: string; name_en: string; museum_count: number };
export type MkListRow = { published_on: string; n: number };

/** The 12 provinces ordered by code, each with its count of visible museums. */
export async function listProvinces(db: Db): Promise<ProvinceRow[]> {
  const rows = await db
    .selectFrom('pub_province')
    .select(['code', 'name_nl', 'name_en', 'museum_count'])
    .orderBy('code')
    .execute();
  return rows.map((r) => ({
    code: r.code as string,
    name_nl: r.name_nl as string,
    name_en: r.name_en as string,
    museum_count: Number(r.museum_count),
  }));
}

/** The newest published list (its date and N), or null before the first one. */
export async function currentMkList(db: Db): Promise<MkListRow | null> {
  const row = await db.selectFrom('pub_mk_list').select(['published_on', 'n']).executeTakeFirst();
  if (row === undefined || row.published_on === null || row.n === null) return null;
  return { published_on: row.published_on, n: Number(row.n) };
}
