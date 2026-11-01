import pg from 'pg';
import { applyRoles } from '../scripts/dev-db.ts';
import { type DbLogin, LOGINS } from '../src/db/migrate.ts';
import { run } from '../src/main.ts';

// Integration-test helper. Needs DATABASE_URL: a superuser of a throw-away
// PostgreSQL 18 cluster (CI's service container). Creates a database of its own
// with the five logins applied; migrations are the caller's job.

let counter = 0;

export type TestDb = {
  /** Superuser URL of the new database, plus one URL per login. */
  urls: Record<DbLogin | 'admin', string>;
  drop: () => Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const server = process.env.DATABASE_URL ?? '';
  const admin = new URL(server);
  const name = `mjk_it_${process.pid}_${counter++}`;
  const maintenance = new pg.Client({ connectionString: server });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${name}`);
  } finally {
    await maintenance.end();
  }
  const drop = async () => {
    const c = new pg.Client({ connectionString: server });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
  try {
    admin.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: admin.href });
    await client.connect();
    let passwords: Record<DbLogin, string>;
    try {
      passwords = await applyRoles(client);
    } finally {
      await client.end();
    }
    const urls = { admin: admin.href } as TestDb['urls'];
    for (const login of LOGINS) {
      const u = new URL(admin.href);
      u.username = login;
      u.password = passwords[login];
      urls[login] = u.href;
    }
    return { urls, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}

/** createTestDb() plus every migration, applied by the real `migrate` role as mjk_migrator. */
export async function createMigratedDb(): Promise<TestDb> {
  const db = await createTestDb();
  try {
    const log: string[] = [];
    const code = await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: db.urls.mjk_migrator }, (l) =>
      log.push(l),
    );
    if (code !== 0) throw new Error(`migrate exited ${code}: ${log.join(' | ')}`);
    return db;
  } catch (err) {
    await db.drop();
    throw err;
  }
}
