import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { type DbLogin, LOGINS } from '../src/db/migrate.ts';

// Development and test only: applies deploy/postgres/roles.sql to the database
// the client is connected to, as a superuser. Each password is a random value
// written on the SERVER by COPY (so it works for a container too) and read back
// by roles.sql; the files are emptied afterwards. Passwords are only returned.

const ROLES_SQL = readFileSync(fileURLToPath(new URL('../../../deploy/postgres/roles.sql', import.meta.url)), 'utf8');

/** `client` must be ONE connection (not a pool), so the SET sticks. */
export async function applyRoles(client: pg.Client): Promise<Record<DbLogin, string>> {
  const prefix = `/tmp/mjkdev_${randomBytes(6).toString('hex')}_db_`;
  const passwords = {} as Record<DbLogin, string>;
  try {
    for (const login of LOGINS) {
      passwords[login] = randomBytes(24).toString('base64url'); // 32 chars of A-Za-z0-9_-
      await client.query(`COPY (SELECT '${passwords[login]}') TO '${prefix}${login}'`);
    }
    await client.query(`SET mjk.secret_prefix = '${prefix}'`);
    await client.query(ROLES_SQL);
  } finally {
    for (const login of LOGINS)
      await client.query(`COPY (SELECT 1 WHERE false) TO '${prefix}${login}'`).catch(() => {});
    await client.query('RESET mjk.secret_prefix').catch(() => {});
  }
  return passwords;
}

if (import.meta.main) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await applyRoles(client);
    console.log('roles applied (passwords are random and not printed)');
  } finally {
    await client.end();
  }
}
