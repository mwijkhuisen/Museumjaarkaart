import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyRoles } from '../scripts/dev-db.ts';
import { LOGINS } from '../src/db/migrate.ts';
import { createTestDb, type TestDb } from './db.ts';

// deploy/postgres/roles.sql (A§8): the five logins, their attributes and what
// they may reach, proven against a real server.

const ROLES_SQL = readFileSync(fileURLToPath(new URL('../../../deploy/postgres/roles.sql', import.meta.url)), 'utf8');

let db: TestDb;
const clients: pg.Client[] = [];
const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const withLogin = (url: string, login: string, password?: string) => {
  const u = new URL(url);
  u.username = login;
  if (password !== undefined) u.password = password;
  return u;
};

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

it('each login can log in and has no privileged attribute; the database belongs to mjk_migrator', async () => {
  const c = await connect(db.urls.admin);
  const { rows } = await c.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
    [[...LOGINS]],
  );
  expect(rows.map((r) => r.rolname)).toEqual([...LOGINS].sort());
  for (const r of rows) {
    expect(r, r.rolname).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  }
  const owner = await c.query(
    'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
  );
  expect(owner.rows[0].owner).toBe('mjk_migrator');
});

it('mjk_backup is a member of pg_read_all_data and of no other role', async () => {
  const c = await connect(db.urls.admin);
  const { rows } = await c.query(
    `SELECT pg_get_userbyid(roleid) AS role, inherit_option FROM pg_auth_members WHERE member = 'mjk_backup'::regrole`,
  );
  expect(rows).toEqual([{ role: 'pg_read_all_data', inherit_option: true }]);
  const others = await c.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = ANY($1::regrole[])`, [
    LOGINS.filter((l) => l !== 'mjk_backup'),
  ]);
  expect(others.rows[0].n).toBe(0);
});

it('no login can connect to the postgres database, and mjk_api can connect to its own', async () => {
  for (const login of LOGINS) {
    const u = withLogin(db.urls.admin, login, new URL(db.urls[login]).password);
    u.pathname = '/postgres';
    expect(await code(connect(u.href)), login).toBe('42501');
  }
  const c = await connect(db.urls.mjk_api);
  expect((await c.query('SELECT current_user')).rows[0].current_user).toBe('mjk_api');
});

it('applying roles.sql a second time succeeds and the new passwords work', async () => {
  const admin = new pg.Client({ connectionString: db.urls.admin });
  await admin.connect();
  let passwords: Awaited<ReturnType<typeof applyRoles>>;
  try {
    passwords = await applyRoles(admin);
  } finally {
    await admin.end();
  }
  for (const login of LOGINS) {
    const c = await connect(withLogin(db.urls.admin, login, passwords[login]).href);
    expect((await c.query('SELECT current_user')).rows[0].current_user).toBe(login);
  }
  // the old password no longer works
  expect(await code(connect(db.urls.mjk_api))).toBe('28P01');
  // and the new passwords are the ones to use from here on
  for (const login of LOGINS) db.urls[login] = withLogin(db.urls.admin, login, passwords[login]).href;
});

it('mjk_backup reads a table of mjk_migrator but cannot write; mjk_api and mjk_ssr cannot read it', async () => {
  const migrator = await connect(db.urls.mjk_migrator);
  await migrator.query('CREATE TABLE probe (id int)');
  await migrator.query('INSERT INTO probe VALUES (1)');
  const backup = await connect(db.urls.mjk_backup);
  expect((await backup.query('SELECT id FROM probe')).rows).toEqual([{ id: 1 }]);
  expect(await code(backup.query('INSERT INTO probe VALUES (2)'))).toBe('42501');
  expect(await code((await connect(db.urls.mjk_api)).query('SELECT id FROM probe'))).toBe('42501');
  expect(await code((await connect(db.urls.mjk_ssr)).query('SELECT id FROM probe'))).toBe('42501');
  expect(await code((await connect(db.urls.mjk_worker)).query('SELECT id FROM probe'))).toBe('42501');
});

it('a too-short secret fails with a fixed error text that does not hold the value', async () => {
  const bad = `short${randomBytes(3).toString('hex')}`; // 11 characters: below the 24 minimum
  const prefix = `/tmp/mjkdev_${randomBytes(6).toString('hex')}_db_`;
  const c = await connect(db.urls.admin);
  const target = 'mjk_ssr';
  try {
    for (const login of LOGINS) {
      const value = login === target ? bad : randomBytes(24).toString('base64url');
      await c.query(`COPY (SELECT '${value}') TO '${prefix}${login}'`);
    }
    await c.query(`SET mjk.secret_prefix = '${prefix}'`);
    const error = await c.query(ROLES_SQL).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error, 'roles.sql must fail').toBeDefined();
    expect(error?.message).toBe(`roles.sql: cannot set up login ${target} (SQLSTATE 22023)`);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(bad)).toBe(false);
  } finally {
    for (const login of LOGINS) await c.query(`COPY (SELECT 1 WHERE false) TO '${prefix}${login}'`).catch(() => {});
    await c.query('RESET mjk.secret_prefix').catch(() => {});
  }
});

it('uuidv7() works for mjk_api: version 7, increasing (A§8)', async () => {
  const c = await connect(db.urls.mjk_api);
  const { rows } = await c.query<{ a: string; b: string }>('SELECT uuidv7()::text AS a, uuidv7()::text AS b');
  const { a, b } = rows[0] as { a: string; b: string };
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(a).toMatch(shape);
  expect(b).toMatch(shape);
  expect(b > a).toBe(true);
});
