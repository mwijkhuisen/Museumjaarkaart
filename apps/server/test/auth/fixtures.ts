import { TERMS_VERSION } from '@mjk/contracts';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The shared fixture of P2a's integration tests: a migrated database, Kysely as mjk_api and as
// mjk_worker, and the superuser for what no login may do (backdating rows to stand in for a clock,
// deleting a user). Each test file opens its own (createMigratedDb, F1's pattern).

export type AuthDb = {
  tdb: TestDb;
  /** As mjk_api. */
  db: Db;
  /** As mjk_worker. */
  worker: Db;
  /** The superuser: fixtures and backdating only, never the code under test. */
  admin: pg.Client;
  newUser(
    opts?: Partial<{ email: string; handle: string; role: string; status: string; password_hash: string }>,
  ): Promise<{
    id: string;
    email: string;
    handle: string;
  }>;
  close(): Promise<void>;
};

let seq = 0;

export async function openAuthDb(): Promise<AuthDb> {
  const tdb = await createMigratedDb();
  const db = createDb(new pg.Pool({ connectionString: tdb.urls.mjk_api, max: 12 }));
  const worker = createDb(new pg.Pool({ connectionString: tdb.urls.mjk_worker, max: 4 }));
  const admin = new pg.Client({ connectionString: tdb.urls.admin });
  await admin.connect();
  return {
    tdb,
    db,
    worker,
    admin,
    async newUser(opts = {}) {
      seq += 1;
      const email = opts.email ?? `member${seq}.${process.pid}@example.org`;
      const handle = opts.handle ?? `member_${seq}_${process.pid % 10_000}`;
      const row = await admin.query<{ id: string }>(
        `INSERT INTO app_user (email, email_verified_at, handle, display_name, role, status, password_hash,
           age_confirmed_at, terms_version, terms_accepted_at)
         VALUES ($1, now(), $2, 'Member', $3, $4, $5, now(), $6, now()) RETURNING id`,
        [email, handle, opts.role ?? 'user', opts.status ?? 'active', opts.password_hash ?? null, TERMS_VERSION],
      );
      return { id: row.rows[0]?.id as string, email, handle };
    },
    async close() {
      await admin.end();
      await db.destroy();
      await worker.destroy();
      await tdb.drop();
    },
  };
}
