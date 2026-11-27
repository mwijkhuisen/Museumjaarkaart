import pg from 'pg';
import { PG_TYPES } from '../../src/db/pool.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';
import { type SeededCatalogue, seedCatalogue } from '../seed-catalogue.ts';

// The shared fixture of P2c's integration tests: P2a's AuthDb (a migrated database, mjk_api and mjk_worker
// through Kysely, the superuser) plus the seeded 1,400-museum catalogue, a pool per login that the passport
// code reads as, and helpers that make members, visits and wishlist entries. Rows that no login may write
// freely (a member, a backdated created_at) are written as mjk_migrator, which owns the tables.

export type PassportDb = AuthDb & {
  catalogue: SeededCatalogue;
  /** Raw pg pools with production's type parsers (a `date` is a string): the passport code runs as these logins. */
  pools: { api: pg.Pool; ssr: pg.Pool; worker: pg.Pool };
  /** As mjk_migrator: fixtures and backdating only, never the code under test. */
  owner: pg.Client;
  newMember(
    opts?: Partial<{ handle: string; status: string; settings: Record<string, unknown> }>,
  ): Promise<{ id: string; email: string; handle: string }>;
  addVisit(
    userId: string,
    museumId: string,
    opts?: Partial<{ on: string | null; note: string; source: string; ageHours: number }>,
  ): Promise<string>;
  addWishlist(userId: string, museumId: string): Promise<void>;
  /** A visible museum that is on the newest list; the n-th one in id order. */
  listed(n?: number): Promise<{ id: string; slug: string }>;
  /** A visible museum, the n-th one in id order, that is not on the list. */
  visible(n?: number): Promise<{ id: string; slug: string }>;
  /** A hidden museum. */
  hidden(): Promise<{ id: string; slug: string }>;
  /** A visible museum of a province (e.g. 'NL-NH'), the n-th one in id order. */
  inProvince(code: string, n?: number): Promise<{ id: string; slug: string }>;
};

export async function openPassportDb(): Promise<PassportDb> {
  const a = await openAuthDb();
  try {
    const catalogue = await seedCatalogue(a.tdb);
    const owner = new pg.Client({ connectionString: a.tdb.urls.mjk_migrator });
    await owner.connect();
    const pools = {
      api: new pg.Pool({ connectionString: a.tdb.urls.mjk_api, max: 4, types: PG_TYPES }),
      ssr: new pg.Pool({ connectionString: a.tdb.urls.mjk_ssr, max: 4, types: PG_TYPES }),
      worker: new pg.Pool({ connectionString: a.tdb.urls.mjk_worker, max: 4, types: PG_TYPES }),
    };
    const one = async (sql: string, params: unknown[] = []) => {
      const r = await owner.query<{ id: string; slug: string }>(sql, params);
      const row = r.rows[0];
      if (row === undefined) throw new Error('passport fixture: no such museum');
      return row;
    };
    const baseClose = a.close;
    return {
      ...a,
      catalogue,
      pools,
      owner,
      async newMember(opts = {}) {
        const u = await a.newUser({
          ...(opts.handle === undefined ? {} : { handle: opts.handle }),
          ...(opts.status === undefined ? {} : { status: opts.status }),
        });
        if (opts.settings !== undefined)
          await owner.query('UPDATE app_user SET settings = $2::jsonb WHERE id = $1', [
            u.id,
            JSON.stringify(opts.settings),
          ]);
        return u;
      },
      async addVisit(userId, museumId, opts = {}) {
        const r = await owner.query<{ id: string }>(
          `INSERT INTO visit (user_id, museum_id, visited_on, note, source, created_at)
           VALUES ($1, $2, $3, $4, $5, now() - make_interval(hours => $6)) RETURNING id`,
          [
            userId,
            museumId,
            opts.on === undefined ? '2026-05-01' : opts.on,
            opts.note ?? null,
            opts.source ?? 'manual',
            opts.ageHours ?? 0,
          ],
        );
        return (r.rows[0] as { id: string }).id;
      },
      async addWishlist(userId, museumId) {
        await owner.query('INSERT INTO wishlist (user_id, museum_id) VALUES ($1, $2)', [userId, museumId]);
      },
      listed: (n = 0) =>
        one(
          `SELECT m.id, m.slug FROM mk_list l JOIN mk_list_member mm ON mm.list_version_id = l.list_version_id
             JOIN museum m ON m.id = mm.museum_id WHERE NOT m.hidden ORDER BY m.id OFFSET $1 LIMIT 1`,
          [n],
        ),
      visible: (n = 0) =>
        one(
          `SELECT id, slug FROM museum m WHERE NOT hidden
              AND NOT EXISTS (SELECT 1 FROM mk_list l JOIN mk_list_member mm ON mm.list_version_id = l.list_version_id
                               WHERE mm.museum_id = m.id)
            ORDER BY id OFFSET $1 LIMIT 1`,
          [n],
        ),
      hidden: () => one('SELECT id, slug FROM museum WHERE hidden ORDER BY id LIMIT 1'),
      inProvince: (code, n = 0) =>
        one(
          `SELECT m.id, m.slug FROM museum m JOIN municipality mu ON mu.cbs_code = m.municipality_code
            WHERE NOT m.hidden AND mu.province_code = $1 ORDER BY m.id OFFSET $2 LIMIT 1`,
          [code, n],
        ),
      async close() {
        await owner.end();
        await Promise.all(Object.values(pools).map((p) => p.end()));
        await baseClose();
      },
    };
  } catch (err) {
    await a.close();
    throw err;
  }
}
