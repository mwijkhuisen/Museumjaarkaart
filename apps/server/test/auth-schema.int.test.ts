import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// P2a (db/migrations/20261127000001_accounts.sql and 20261127000002_actor_foreign_keys.sql): the CHECKs behind
// the zod schemas, the delete behaviour of the actor keys and the extension. Rows are written as mjk_api;
// only what no login may write (a user delete, the actor-key fixtures) goes through the superuser.

let db: TestDb;
let api: pg.Client;
let admin: pg.Client;
const clients: pg.Client[] = [];
let n = 0;

const CHECK = '23514';
const HASH = Buffer.alloc(32, 7);

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
const tryInsert = (table: string, row: Record<string, unknown>, c = api) => {
  const q = insertSql(table, row);
  return attempt(c, q.sql, q.params);
};
const insertReturning = async (table: string, row: Record<string, unknown>, c = api) => {
  const q = insertSql(table, row);
  return ((await c.query<{ id: string }>(`${q.sql} RETURNING id`, q.params)).rows[0] as { id: string }).id;
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
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  db = await createMigratedDb();
  api = await connect(db.urls.mjk_api);
  admin = await connect(db.urls.admin);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

describe('CHECK constraints', () => {
  it('accepts a good user, and refuses a bad handle, email or password hash', async () => {
    expect(await tryInsert('app_user', userRow())).toBe('ok');
    expect(await tryInsert('app_user', userRow({ handle: 'ABC' }))).toBe(CHECK); // ~ on citext would let it through
    expect(await tryInsert('app_user', userRow({ handle: 'Abc_def' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ handle: 'ab' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ handle: 'a'.repeat(31) }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ handle: 'with-dash' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ email: 'Upper@Example.org' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ password_hash: 'plain text' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ password_hash: '$argon2i$v=19$m=65536,t=3,p=1$x$y' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ password_hash: `$argon2id$${'x'.repeat(200)}` }))).toBe(CHECK);
    expect(
      await tryInsert('app_user', userRow({ password_hash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA' })),
    ).toBe('ok');
    expect(await tryInsert('app_user', userRow({ settings: '[]' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ settings: '{"locale":"nl"}' }))).toBe('ok');
    expect(await tryInsert('app_user', userRow({ role: 'owner' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ status: 'gone' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ display_name: '' }))).toBe(CHECK);
    expect(await tryInsert('app_user', userRow({ display_name: 'x'.repeat(51) }))).toBe(CHECK);
  });

  it('refuses a duplicate email (unique) as 23505', async () => {
    const row = userRow();
    await api.query('BEGIN');
    try {
      const q = insertSql('app_user', row);
      await api.query(q.sql, q.params);
      const again = insertSql('app_user', userRow({ email: row.email }));
      await expect(api.query(again.sql, again.params)).rejects.toMatchObject({ code: '23505' });
    } finally {
      await api.query('ROLLBACK');
    }
  });

  it('email_code.attempts is 0 to 5', async () => {
    const row = (attempts: number) => ({
      email: 'a@example.org',
      purpose: 'signin',
      code_hmac: HASH,
      expires_at: IN_AN_HOUR(),
      attempts,
    });
    expect(await tryInsert('email_code', row(5))).toBe('ok');
    expect(await tryInsert('email_code', row(6))).toBe(CHECK);
    expect(await tryInsert('email_code', row(-1))).toBe(CHECK);
    expect(await tryInsert('email_code', { ...row(0), purpose: 'login' })).toBe(CHECK);
    expect(await tryInsert('email_code', { ...row(0), code_hmac: Buffer.alloc(31) })).toBe(CHECK);
    expect(await tryInsert('email_code', { ...row(0), pending: '[]' })).toBe(CHECK);
  });

  it('invite: uses never above max_uses, max_uses 1 to 1000, a 32-byte hmac', async () => {
    const row = (extra: Record<string, unknown>) => ({ code_hmac: HASH, ...extra });
    expect(await tryInsert('invite', row({ max_uses: 3, uses: 3 }))).toBe('ok');
    expect(await tryInsert('invite', row({ max_uses: 3, uses: 4 }))).toBe(CHECK);
    expect(await tryInsert('invite', row({ uses: -1 }))).toBe(CHECK);
    expect(await tryInsert('invite', row({ max_uses: 0 }))).toBe(CHECK);
    expect(await tryInsert('invite', row({ max_uses: 1001 }))).toBe(CHECK);
    expect(await tryInsert('invite', row({ note: 'x'.repeat(201) }))).toBe(CHECK);
    expect(await tryInsert('invite', { code_hmac: Buffer.alloc(16) })).toBe(CHECK);
  });

  it('session: expires_at never past absolute_expires_at, a 32-byte id, a known host and method', async () => {
    const userId = await insertReturning('app_user', userRow());
    const soon = new Date(Date.now() + 1000);
    const later = IN_AN_HOUR();
    const row = (extra: Record<string, unknown>) => ({
      id: HASH,
      user_id: userId,
      host: 'public',
      method: 'code',
      expires_at: soon,
      absolute_expires_at: later,
      ...extra,
    });
    expect(await tryInsert('session', row({}))).toBe('ok');
    expect(await tryInsert('session', row({ expires_at: later, absolute_expires_at: soon }))).toBe(CHECK);
    expect(await tryInsert('session', row({ id: Buffer.alloc(31) }))).toBe(CHECK);
    expect(await tryInsert('session', row({ host: 'other' }))).toBe(CHECK);
    expect(await tryInsert('session', row({ method: 'magic' }))).toBe(CHECK);
  });

  it('auth_challenge, rate_limit, audit_log and content_ip_log refuse bad values', async () => {
    const future = IN_AN_HOUR();
    expect(
      await tryInsert('auth_challenge', { purpose: 'altcha', host: 'public', value_hash: HASH, expires_at: future }),
    ).toBe('ok');
    expect(
      await tryInsert('auth_challenge', { purpose: 'captcha', host: 'public', value_hash: HASH, expires_at: future }),
    ).toBe(CHECK);
    const limit = (extra: Record<string, unknown>) => ({
      bucket: 'signin',
      key: 'ip:1.2.3.0',
      window_start: new Date(),
      window_end: future,
      count: 1,
      ...extra,
    });
    expect(await tryInsert('rate_limit', limit({}))).toBe('ok');
    expect(await tryInsert('rate_limit', limit({ bucket: 'Sign-In' }))).toBe(CHECK);
    expect(await tryInsert('rate_limit', limit({ key: '' }))).toBe(CHECK);
    expect(await tryInsert('rate_limit', limit({ count: -1 }))).toBe(CHECK);
    expect(await tryInsert('rate_limit', limit({ window_end: new Date(0) }))).toBe(CHECK);

    const audit = (extra: Record<string, unknown>) => ({ actor_kind: 'system', action: 'user.signup', ...extra });
    expect(await tryInsert('audit_log', audit({}))).toBe('ok');
    expect(await tryInsert('audit_log', audit({ actor_kind: 'robot' }))).toBe(CHECK);
    expect(await tryInsert('audit_log', audit({ action: 'Sign Up' }))).toBe(CHECK);
    expect(await tryInsert('audit_log', audit({ target_kind: 'User' }))).toBe(CHECK);
    expect(await tryInsert('audit_log', audit({ detail: '[]' }))).toBe(CHECK);

    const ip = { target_kind: 'review', target_id: '0197f0a2-0000-7000-8000-000000000001', ip: '203.0.113.7' };
    expect(await tryInsert('content_ip_log', ip)).toBe('ok');
    expect(await tryInsert('content_ip_log', { ...ip, target_kind: 'Review' })).toBe(CHECK);
  });
});

describe('deleting an app_user (as the superuser: no login may)', () => {
  it('cascades to sessions, sets the actor keys to NULL and leaves audit_log alone', async () => {
    const userId = await insertReturning('app_user', userRow(), admin);
    const later = IN_AN_HOUR();
    await admin.query(
      `INSERT INTO session (id, user_id, host, method, expires_at, absolute_expires_at)
       VALUES ($1, $2, 'public', 'code', $3, $3)`,
      [HASH, userId, later],
    );
    const inviteId = await insertReturning('invite', { code_hmac: HASH, created_by: userId }, admin);
    await admin.query('INSERT INTO content_ip_log (user_id, target_kind, target_id, ip) VALUES ($1, $2, $1, $3)', [
      userId,
      'review',
      '203.0.113.7',
    ]);
    await admin.query('INSERT INTO audit_log (actor_id, actor_kind, action) VALUES ($1, $2, $3)', [
      userId,
      'user',
      'user.signup',
    ]);
    const museumId = await insertReturning('museum', { slug: `del-${n++}`, name: 'M' }, admin);
    const changeId = await insertReturning(
      'museum_change',
      {
        museum_id: museumId,
        field: 'hidden',
        state: 'applied',
        origin: 'admin',
        decided_by: userId,
        reporter_id: userId,
      },
      admin,
    );
    const versionId = await insertReturning(
      'mk_list_version',
      { published_on: '2026-11-01', published_by: userId },
      admin,
    );
    const memberId = await insertReturning('app_user', userRow({ invite_id: inviteId }), admin);

    await admin.query('DELETE FROM app_user WHERE id = $1', [userId]);

    const count = async (sql: string, p: unknown[]) => Number((await admin.query<{ n: string }>(sql, p)).rows[0]?.n);
    expect(await count('SELECT count(*) AS n FROM session WHERE user_id = $1', [userId])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM content_ip_log WHERE user_id IS NULL', [])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM invite WHERE id = $1 AND created_by IS NULL', [inviteId])).toBe(1);
    expect(
      await count(
        'SELECT count(*) AS n FROM museum_change WHERE id = $1 AND decided_by IS NULL AND reporter_id IS NULL',
        [changeId],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM mk_list_version WHERE id = $1 AND published_by IS NULL', [versionId]),
    ).toBe(1);
    expect(await count('SELECT count(*) AS n FROM audit_log WHERE actor_id = $1', [userId])).toBe(1);

    // and deleting the invite sets the member's invite_id to NULL, keeping the member
    await admin.query('DELETE FROM invite WHERE id = $1', [inviteId]);
    expect(await count('SELECT count(*) AS n FROM app_user WHERE id = $1 AND invite_id IS NULL', [memberId])).toBe(1);
  });
});

describe('the actor foreign keys of 20261127000002', () => {
  it('are validated, ON DELETE SET NULL', async () => {
    const { rows } = await admin.query<{ conname: string; convalidated: boolean; confdeltype: string }>(
      `SELECT conname, convalidated, confdeltype FROM pg_constraint
        WHERE conname IN ('museum_change_reporter_id_fkey', 'museum_change_decided_by_fkey', 'mk_list_version_published_by_fkey')
        ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'mk_list_version_published_by_fkey',
      'museum_change_decided_by_fkey',
      'museum_change_reporter_id_fkey',
    ]);
    for (const r of rows) {
      expect(r.convalidated, r.conname).toBe(true);
      expect(r.confdeltype, r.conname).toBe('n');
    }
  });

  it('refuse an actor that is no user', async () => {
    const museumId = await insertReturning('museum', { slug: `fk-${n++}`, name: 'M' }, admin);
    expect(
      await tryInsert(
        'museum_change',
        { museum_id: museumId, field: 'hidden', state: 'applied', decided_by: '0197f0a2-0000-7000-8000-000000000001' },
        admin,
      ),
    ).toBe('23503');
  });
});

describe('citext', () => {
  it('exists, and is a trusted extension (mjk_migrator creates it without a superuser)', async () => {
    const { rows } = await admin.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'citext'",
    );
    expect(rows).toHaveLength(1);
    const { rows: ctl } = await admin.query<{ trusted: boolean }>(
      "SELECT trusted FROM pg_available_extension_versions WHERE name = 'citext' AND installed",
    );
    expect(ctl[0]?.trusted).toBe(true);
  });
});
