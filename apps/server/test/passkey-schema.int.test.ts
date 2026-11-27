import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// P2b (db/migrations/20261128000001_passkeys.sql): the CHECKs behind the zod schemas, the unique keys, the
// cascade and app_user.webauthn_user_id. Rows are written as mjk_api; only what no login may do (a user
// delete, the rollback) goes through the superuser and mjk_migrator.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

let db: TestDb;
let api: pg.Client;
let admin: pg.Client;
const clients: pg.Client[] = [];
let n = 0;

const CHECK = '23514';
const NOT_NULL = '23502';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};

/** One statement in a transaction that is always rolled back: 'ok' or its SQLSTATE. */
async function attempt(c: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  await c.query('BEGIN');
  try {
    await c.query(sql, params);
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    await c.query('ROLLBACK');
  }
}

function insertSql(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    params: Object.values(row),
  };
}
/** The insert as mjk_api, rolled back: 'ok' or its SQLSTATE. */
const tryInsert = (table: string, row: Record<string, unknown>) => {
  const q = insertSql(table, row);
  return attempt(api, q.sql, q.params);
};
/** The insert as mjk_api, kept; returns the named column of the new row. */
const insertReturning = async <T>(table: string, row: Record<string, unknown>, column: string) => {
  const q = insertSql(table, row);
  return ((await api.query<Record<string, T>>(`${q.sql} RETURNING ${column}`, q.params)).rows[0] as Record<string, T>)[
    column
  ] as T;
};

const userRow = (extra: Record<string, unknown> = {}) => {
  const k = n++;
  return {
    email: `user${k}@example.org`,
    email_verified_at: new Date(),
    handle: `user_${k}`,
    display_name: 'User',
    age_confirmed_at: new Date(),
    terms_version: '2026-11-27',
    terms_accepted_at: new Date(),
    ...extra,
  };
};
const newUser = () => insertReturning<string>('app_user', userRow(), 'id');
const bytes = (len: number, fill = 1) => Buffer.alloc(len, fill);
let userId: string;
let credN = 0;
/** A good passkey row: a unique 32-byte credential id unless the test sets one. */
const passkeyRow = (extra: Record<string, unknown> = {}) => ({
  credential_id: Buffer.from(`cred-${credN++}-`.padEnd(32, 'x')),
  user_id: userId,
  public_key: bytes(77),
  backed_up: false,
  ...extra,
});
const count = async (sql: string, params: unknown[] = []) =>
  Number(((await admin.query<{ n: string }>(sql, params)).rows[0] as { n: string }).n);

beforeAll(async () => {
  db = await createMigratedDb();
  api = await connect(db.urls.mjk_api);
  admin = await connect(db.urls.admin);
  userId = await newUser();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('passkey CHECK constraints', () => {
  it('accepts a good row and fills the defaults', async () => {
    const q = insertSql('passkey', passkeyRow());
    const row = (
      await api.query<Record<string, unknown>>(
        `${q.sql} RETURNING ref, sign_count, transports, name, created_at, last_used_at`,
        q.params,
      )
    ).rows[0] as Record<string, unknown>;
    expect(row.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.sign_count).toBe('0');
    expect(row.transports).toEqual([]);
    expect(row.name).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.last_used_at).toBeNull();
  });

  it('credential_id is 1 to 1,023 bytes', async () => {
    expect(await tryInsert('passkey', passkeyRow({ credential_id: bytes(0) }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ credential_id: bytes(1) }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ credential_id: bytes(1023) }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ credential_id: bytes(1024) }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ credential_id: null }))).toBe(NOT_NULL);
  });

  it('public_key is 1 to 2,048 bytes', async () => {
    expect(await tryInsert('passkey', passkeyRow({ public_key: bytes(0) }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ public_key: bytes(1) }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ public_key: bytes(2048) }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ public_key: bytes(2049) }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ public_key: null }))).toBe(NOT_NULL);
  });

  it('sign_count is 0 to 4294967295 (an unsigned 32-bit counter)', async () => {
    expect(await tryInsert('passkey', passkeyRow({ sign_count: -1 }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ sign_count: 0 }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ sign_count: 4294967295 }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ sign_count: 4294967296 }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ sign_count: null }))).toBe(NOT_NULL);
  });

  it('transports is a flat array of at most 8 known values, never NULL inside', async () => {
    const all = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];
    expect(await tryInsert('passkey', passkeyRow({ transports: [] }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ transports: ['internal', 'hybrid'] }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ transports: all }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ transports: Array(8).fill('usb') }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ transports: ['usb', 'fido'] }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ transports: ['USB'] }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ transports: ['usb', null] }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ transports: Array(9).fill('usb') }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ transports: [['usb']] }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ transports: null }))).toBe(NOT_NULL);
  });

  it('name is NULL or 1 to 50 characters', async () => {
    expect(await tryInsert('passkey', passkeyRow({ name: null }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ name: '' }))).toBe(CHECK);
    expect(await tryInsert('passkey', passkeyRow({ name: 'a' }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ name: 'é'.repeat(50) }))).toBe('ok'); // characters, not bytes
    expect(await tryInsert('passkey', passkeyRow({ name: 'a'.repeat(51) }))).toBe(CHECK);
  });

  it('backed_up has no default, and user_id must exist', async () => {
    const { backed_up: _omitted, ...withoutBackedUp } = passkeyRow();
    expect(await tryInsert('passkey', withoutBackedUp)).toBe(NOT_NULL);
    expect(await tryInsert('passkey', passkeyRow({ backed_up: null }))).toBe(NOT_NULL);
    expect(await tryInsert('passkey', passkeyRow({ backed_up: true }))).toBe('ok');
    expect(await tryInsert('passkey', passkeyRow({ user_id: null }))).toBe(NOT_NULL);
    expect(await tryInsert('passkey', passkeyRow({ user_id: '0197f0a2-0000-7000-8000-000000000001' }))).toBe(
      FOREIGN_KEY,
    );
  });
});

describe('passkey keys', () => {
  it('a duplicate credential_id is refused, also across users', async () => {
    const id = Buffer.from('dup-credential-id');
    await insertReturning('passkey', passkeyRow({ credential_id: id }), 'ref');
    expect(await tryInsert('passkey', passkeyRow({ credential_id: id }))).toBe(UNIQUE);
    expect(await tryInsert('passkey', passkeyRow({ credential_id: id, user_id: await newUser() }))).toBe(UNIQUE);
  });

  it('ref is filled by default, is unique and is NOT NULL', async () => {
    const a = await insertReturning<string>('passkey', passkeyRow(), 'ref');
    const b = await insertReturning<string>('passkey', passkeyRow(), 'ref');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(await tryInsert('passkey', passkeyRow({ ref: a }))).toBe(UNIQUE);
    expect(await tryInsert('passkey', passkeyRow({ ref: null }))).toBe(NOT_NULL);
  });

  it('deleting a user (as the superuser) deletes its passkeys and no others', async () => {
    const doomed = await newUser();
    const kept = await newUser();
    for (const [uid, k] of [
      [doomed, 2],
      [kept, 3],
    ] as const)
      for (let i = 0; i < k; i++) await insertReturning('passkey', passkeyRow({ user_id: uid }), 'ref');
    const before = await count('SELECT count(*) AS n FROM passkey');
    expect(await count('SELECT count(*) AS n FROM passkey WHERE user_id = $1', [doomed])).toBe(2);
    await admin.query('DELETE FROM app_user WHERE id = $1', [doomed]);
    expect(await count('SELECT count(*) AS n FROM passkey WHERE user_id = $1', [doomed])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM passkey WHERE user_id = $1', [kept])).toBe(3);
    expect(await count('SELECT count(*) AS n FROM passkey')).toBe(before - 2);
  });
});

describe('app_user.webauthn_user_id', () => {
  it('every new user gets 16 random bytes, and two users never share one', async () => {
    const ids: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertReturning<Buffer>('app_user', userRow(), 'webauthn_user_id');
      expect(Buffer.isBuffer(id)).toBe(true);
      expect(id).toHaveLength(16);
      ids.push(id);
    }
    expect(new Set(ids.map((b) => b.toString('hex'))).size).toBe(5);
  });

  it('is NOT NULL, UNIQUE and exactly 16 bytes when set explicitly', async () => {
    const taken = (await admin.query<{ webauthn_user_id: Buffer }>('SELECT webauthn_user_id FROM app_user LIMIT 1'))
      .rows[0]?.webauthn_user_id;
    expect(taken).toBeDefined();
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: taken }))).toBe(UNIQUE);
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: bytes(16, 9) }))).toBe('ok');
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: bytes(15, 9) }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: bytes(17, 9) }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: bytes(0) }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ webauthn_user_id: null }))).toBe(NOT_NULL);
  });
});

// Last on purpose: it rolls the migration back and applies it again.
describe('the migration on a database that already has users', () => {
  it('rolls back, and migrating again gives every existing user its own 16 random bytes', {
    timeout: 60_000,
  }, async () => {
    const env = { PATH: process.env.PATH, DATABASE_URL: db.urls.mjk_migrator };
    const dbmate = async (...args: string[]) =>
      (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;

    // This migration is the last one: rolling it back drops passkey and the column.
    await dbmate('rollback');
    expect(
      await count(
        "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'app_user' AND column_name = 'webauthn_user_id'",
      ),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM pg_class WHERE relname = 'passkey'")).toBe(0);

    // Users written while the column is absent (as mjk_api), on top of the ones from the tests above.
    const emails: string[] = [];
    for (let i = 0; i < 4; i++) {
      const row = userRow();
      emails.push(row.email);
      const q = insertSql('app_user', row);
      await api.query(q.sql, q.params);
    }

    await dbmate('migrate');
    expect(await dbmate('status')).toMatch(/^Pending: 0$/m);

    const { rows } = await admin.query<{ id: string; email: string; webauthn_user_id: Buffer }>(
      'SELECT id, email, webauthn_user_id FROM app_user',
    );
    for (const e of emails) expect(rows.some((r) => r.email === e)).toBe(true);
    for (const r of rows) expect(r.webauthn_user_id).toHaveLength(16);
    // a constant default would give every row the same value
    expect(new Set(rows.map((r) => r.webauthn_user_id.toString('hex'))).size).toBe(rows.length);

    // back in the migrated state: the table and its grants work again
    const first = rows.find((r) => r.email === emails[0]) as { id: string };
    expect(await tryInsert('passkey', passkeyRow({ user_id: first.id }))).toBe('ok');
  });
});
