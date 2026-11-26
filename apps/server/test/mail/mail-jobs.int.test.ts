import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { seal } from '../../src/auth/crypto.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import type { Pinger } from '../../src/lib/healthchecks.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { memoryMailer } from '../../src/mail/mailer.ts';
import { aad, enqueueMailCode, enqueueMailInvite, enqueueMailNotice } from '../../src/mail/payloads.ts';
import { pingWorkerHealth } from '../../src/worker/health-ping.ts';
import { mailJobs } from '../../src/worker/mail.ts';
import { runWorker } from '../../src/worker/worker.ts';
import { makeTestKeys } from '../auth/test-keys.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// The mail jobs against a real PostgreSQL: the api enqueues inside its transaction, the real worker loop
// runs the job as mjk_worker with the in-memory mailer, and the row is gone afterwards (A§9, A§17.7).

const BRAND = ['Test', 'Brand'].join('');
const ENV = {
  MJK_BRAND_NAME: BRAND,
  MJK_DOMAIN: 'example.test',
  MJK_CONTACT_EMAIL: 'help@example.test',
};
const EMAIL = 'alice.secret@example.test';
const CODE = '482915';
const INVITE_CODE = '0123456789ABCDEF';

const keys = makeTestKeys();
let testDb: TestDb;
let admin: pg.Client;
let apiDb: Db;
let workerDb: Db;
const pools: pg.Pool[] = [];

const dbAs = (login: 'mjk_api' | 'mjk_worker') => {
  const pool = createPool(login, { DATABASE_URL: testDb.urls[login] }, { max: 3 });
  if (typeof pool === 'string') throw new Error(pool);
  pools.push(pool);
  return createDb(pool);
};

beforeAll(async () => {
  testDb = await createMigratedDb();
  admin = new pg.Client({ connectionString: testDb.urls.admin });
  await admin.connect();
  apiDb = dbAs('mjk_api');
  workerDb = dbAs('mjk_worker');
});
beforeEach(async () => {
  await admin.query('TRUNCATE job RESTART IDENTITY');
  await admin.query('TRUNCATE email_code, rate_limit');
  await admin.query('DELETE FROM app_user');
  await admin.query('DELETE FROM invite');
  await admin.query('DELETE FROM museum_sync_run');
});
afterAll(async () => {
  await admin?.end();
  for (const p of pools) await p.end().catch(() => {});
  await testDb?.drop();
});

const addUser = (email: string, status = 'active') =>
  admin.query(
    `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version,
       terms_accepted_at, status)
     VALUES ($1, now(), $2, 'Alice', now(), 'v1', now(), $3)`,
    [email, `u${randomBytes(6).toString('hex')}`, status],
  );

/** The api's side: the email_code row and its job in one transaction. */
const requestCode = (purpose: string, opts: { expiresIn?: string; email?: string; code?: string } = {}) =>
  apiDb.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('email_code')
      .values({
        email: opts.email ?? EMAIL,
        purpose,
        code_hmac: randomBytes(32),
        expires_at: sql<Date>`now() + ${opts.expiresIn ?? '10 minutes'}::interval`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await enqueueMailCode(trx, keys, { emailCodeId: row.id, code: opts.code ?? CODE, locale: 'nl' });
    return row.id;
  });

const newInvite = async () =>
  (
    await admin.query<{ id: string }>(
      `INSERT INTO invite (code_hmac, expires_at) VALUES ($1, '2027-01-31T12:00:00Z') RETURNING id`,
      [randomBytes(32)],
    )
  ).rows[0]?.id as string;

/** Runs the real worker loop until the queue holds no queued or running job. */
async function drain(over: { env?: Record<string, string>; mailer?: ReturnType<typeof memoryMailer> } = {}) {
  const mail = over.mailer ?? memoryMailer();
  const log = memoryLogger('worker');
  const ac = new AbortController();
  const done = runWorker({
    db: workerDb,
    listen: () => new pg.Client({ connectionString: testDb.urls.mjk_worker }),
    handlers: mailJobs({ db: workerDb, keys, mailer: mail.mailer, logger: log.logger, env: { ...ENV, ...over.env } }),
    logger: log.logger,
    signal: ac.signal,
    workerId: 'w-mail',
    pollMs: 50,
    heartbeatPath: join(mkdtempSync(join(tmpdir(), 'mjk-hb-')), 'heartbeat'),
  });
  try {
    for (let i = 0; i < 200; i++) {
      const open = await admin.query(`SELECT count(*)::int AS n FROM job WHERE state IN ('queued', 'running')`);
      if (open.rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    ac.abort();
    await done;
  }
  return { sent: mail.sent(), lines: log.lines() };
}

const jobs = async () => (await admin.query('SELECT kind, state, last_error, payload FROM job ORDER BY id')).rows;
const codeRows = async () => (await admin.query('SELECT id FROM email_code')).rows;

/** Every table's rows as JSON text: the value must appear nowhere, as a quoted string or a bare value. */
async function leaks(needle: string): Promise<string[]> {
  const tables = (await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows;
  const found: string[] = [];
  for (const { tablename } of tables) {
    const rows = await admin.query(`SELECT row_to_json(t)::text AS j FROM "${tablename}" t`);
    for (const { j } of rows.rows) {
      if (j.includes(`"${needle}"`) || new RegExp(`:${needle}[,}]`).test(j)) found.push(tablename);
    }
  }
  return found;
}

it('sends a sign-in code to an active member, once, and leaves no row that holds it', async () => {
  await addUser(EMAIL);
  await requestCode('signin');
  // The job holds the sealed code from the moment it is enqueued, never the code.
  expect(JSON.stringify(await jobs())).not.toContain(CODE);
  expect(await leaks(CODE)).toEqual([]);
  const { sent, lines } = await drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe(EMAIL);
  expect(sent[0]?.text).toContain(CODE);
  expect(sent[0]?.text).toContain(BRAND);
  expect(await jobs()).toEqual([]);
  expect(await leaks(CODE)).toEqual([]);
  expect((await leaks(EMAIL)).sort()).toEqual(['app_user', 'email_code']);
  // The code row stays for the verification; it never holds the code.
  expect(await codeRows()).toHaveLength(1);
  const msgs = lines.map((l) => l.msg);
  expect(msgs).toContain('job_done');
  expect(msgs).not.toContain('job_lease_lost');
});

it('counts a mail in the month window of Europe/Amsterdam', async () => {
  await addUser(EMAIL);
  await requestCode('signin');
  await drain();
  const r = await admin.query(
    `SELECT count, window_start <= now() AND now() < window_end AS inside,
            (window_start AT TIME ZONE 'Europe/Amsterdam')::text AS start,
            (window_end AT TIME ZONE 'Europe/Amsterdam')::text AS "end"
     FROM rate_limit WHERE bucket = 'mail_sent' AND key = 'site'`,
  );
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({ count: 1, inside: true });
  expect(r.rows[0].start).toMatch(/-01 00:00:00$/);
  expect(r.rows[0].end).toMatch(/-01 00:00:00$/);
});

it.each([
  ['signin: no account', 'signin', null],
  ['signin: a banned account', 'signin', 'banned'],
  ['signup: the address has an account', 'signup', 'active'],
  ['email_change: the new address has an account', 'email_change', 'active'],
])('drops %s: nothing is sent, the code row and the job are gone', async (_n, purpose, userStatus) => {
  if (userStatus !== null) await addUser(EMAIL, userStatus);
  await requestCode(purpose);
  const { sent, lines } = await drain();
  expect(sent).toEqual([]);
  expect(await codeRows()).toEqual([]);
  expect(await jobs()).toEqual([]);
  expect(lines.map((l) => l.msg)).toContain('job_done');
  expect((await admin.query(`SELECT count(*)::int AS n FROM rate_limit`)).rows[0].n).toBe(0);
});

it.each([['signup'], ['email_change']])('sends a %s code to an address without an account', async (purpose) => {
  await requestCode(purpose);
  const { sent } = await drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain(CODE);
  expect(await jobs()).toEqual([]);
});

it('sends nothing for an expired code and removes the job', async () => {
  await addUser(EMAIL);
  await requestCode('signin', { expiresIn: '-1 minute' });
  const { sent } = await drain();
  expect(sent).toEqual([]);
  expect(await codeRows()).toEqual([]);
  expect(await jobs()).toEqual([]);
});

it('sends nothing when the code row is gone', async () => {
  await addUser(EMAIL);
  const id = await requestCode('signin');
  await admin.query('DELETE FROM email_code WHERE id = $1', [id]);
  const { sent } = await drain();
  expect(sent).toEqual([]);
  expect(await jobs()).toEqual([]);
});

it('fails a tampered or moved sealed code with seal_invalid and sends nothing', async () => {
  await addUser(EMAIL);
  const id = await requestCode('signin');
  // The code sealed for another job's id: the associated data does not match.
  const moved = seal(keys.code_seal, CODE, aad.code('00000000-0000-7000-8000-000000000000'));
  await admin.query(`UPDATE job SET payload = jsonb_set(payload, '{sealed}', to_jsonb($1::text))`, [moved]);
  const { sent, lines } = await drain();
  expect(sent).toEqual([]);
  expect(await jobs()).toMatchObject([{ kind: 'mail_code', state: 'failed', last_error: 'seal_invalid' }]);
  expect(lines.map((l) => l.msg)).toContain('job_failed');
  expect(id).toBeTruthy();
});

it('fails a payload that is not ours with mail_payload_invalid', async () => {
  await admin.query(`INSERT INTO job (kind, payload) VALUES ('mail_code', '{"email_code_id":"nope"}')`);
  const { sent } = await drain();
  expect(sent).toEqual([]);
  expect(await jobs()).toMatchObject([{ state: 'failed', last_error: 'mail_payload_invalid' }]);
});

it('sends an invite to the opened address with its link and the date, then removes the job', async () => {
  const inviteId = await newInvite();
  await apiDb
    .transaction()
    .execute((trx) => enqueueMailInvite(trx, keys, { inviteId, code: INVITE_CODE, to: EMAIL, locale: 'en' }));
  expect(JSON.stringify(await jobs())).not.toMatch(new RegExp(`${INVITE_CODE}|alice`));
  const { sent } = await drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe(EMAIL);
  expect(sent[0]?.text).toContain(`https://example.test/en/sign-in#invite=${INVITE_CODE}`);
  expect(sent[0]?.text).toContain('2027-01-31');
  expect(await jobs()).toEqual([]);
  expect(await leaks(EMAIL)).toEqual([]);
});

it('sends the notice to the old address and names no other', async () => {
  const userId = '019a0000-0000-7000-8000-000000000001';
  await apiDb.transaction().execute((trx) => enqueueMailNotice(trx, keys, { userId, to: EMAIL, locale: 'nl' }));
  expect(JSON.stringify(await jobs())).not.toContain('alice');
  const { sent } = await drain();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe(EMAIL);
  expect(sent[0]?.text).toContain('help@example.test');
  expect(sent[0]?.text).not.toContain('alice');
  expect(await jobs()).toEqual([]);
});

it('a job rolled back with its transaction never exists', async () => {
  await expect(
    apiDb.transaction().execute(async (trx) => {
      await enqueueMailNotice(trx, keys, { userId: '019a0000-0000-7000-8000-000000000001', to: EMAIL, locale: 'en' });
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await jobs()).toEqual([]);
});

it('a failed send is a fixed code; a code mail is not retried', async () => {
  await addUser(EMAIL);
  await requestCode('signin');
  const failing = {
    mailer: {
      async send() {
        const { MailError } = await import('../../src/mail/mailer.ts');
        throw new MailError('mail_unavailable');
      },
    },
    sent: () => [],
  };
  const { lines } = await drain({ mailer: failing });
  // maxAttempts 1: the one attempt is used, so the job is failed with the code, not requeued.
  expect(await jobs()).toMatchObject([{ state: 'failed', last_error: 'mail_unavailable' }]);
  expect(lines.map((l) => l.msg)).toContain('job_failed');
  expect((await admin.query(`SELECT count(*)::int AS n FROM rate_limit`)).rows[0].n).toBe(0);
});

it('logs mail_cap_near from 80 % of MJK_MAIL_CAP, with only the count and the cap', async () => {
  for (let i = 0; i < 5; i++) {
    await apiDb
      .transaction()
      .execute((trx) =>
        enqueueMailNotice(trx, keys, { userId: `019a0000-0000-7000-8000-00000000000${i}`, to: EMAIL, locale: 'en' }),
      );
  }
  const { sent, lines } = await drain({ env: { MJK_MAIL_CAP: '5' } });
  expect(sent).toHaveLength(5);
  const near = lines.filter((l) => l.msg === 'mail_cap_near');
  // Counts 4 and 5 are at or above 4 of 5; 1 to 3 are below.
  expect(near.map((l) => [l.count, l.cap])).toEqual([
    [4, 5],
    [5, 5],
  ]);
  expect(Object.keys(near[0] ?? {}).sort()).toEqual(['cap', 'count', 'level', 'msg', 'role', 'time']);
});

it('ignores an unset or invalid MJK_MAIL_CAP', async () => {
  for (const cap of [undefined, 'abc', '0', '-5']) {
    await admin.query('TRUNCATE job, rate_limit');
    await apiDb
      .transaction()
      .execute((trx) =>
        enqueueMailNotice(trx, keys, { userId: '019a0000-0000-7000-8000-000000000001', to: EMAIL, locale: 'en' }),
      );
    const { lines } = await drain(cap === undefined ? {} : { env: { MJK_MAIL_CAP: cap } });
    expect(lines.map((l) => l.msg)).not.toContain('mail_cap_near');
  }
});

it('no log line holds the address, the code or the subject', async () => {
  await addUser(EMAIL);
  await requestCode('signin');
  const inviteId = await newInvite();
  await apiDb
    .transaction()
    .execute((trx) =>
      enqueueMailInvite(trx, keys, { inviteId, code: INVITE_CODE, to: 'bob.secret@example.test', locale: 'nl' }),
    );
  await requestCode('signup', { email: 'carol.secret@example.test', code: '735190' });
  await admin.query(`INSERT INTO job (kind, payload) VALUES ('mail_code', '{"x":1}')`);
  const { lines, sent } = await drain({ env: { MJK_MAIL_CAP: '1' } });
  const all = JSON.stringify(lines);
  expect(sent.length).toBeGreaterThan(0);
  for (const secret of [EMAIL, 'bob.secret', 'carol.secret', 'secret@', CODE, '735190', INVITE_CODE]) {
    expect(all).not.toContain(secret);
  }
  for (const m of sent) expect(all).not.toContain(m.subject);
});

it('the health ping fails at 80 % of the cap and passes below it', async () => {
  const pings: string[] = [];
  const pinger: Pinger = {
    enabled: true,
    ping: async (_slug, kind) => {
      pings.push(kind ?? 'success');
      return true;
    },
  };
  const { logger } = memoryLogger();
  await admin.query(
    `INSERT INTO museum_sync_run (mode, started_at, finished_at, outcome)
     VALUES ('sync', now() - interval '2 minutes', now() - interval '1 minute', 'applied')`,
  );
  await pingWorkerHealth(workerDb, pinger, logger, { MJK_MAIL_CAP: '5' });
  await admin.query(
    `INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
     VALUES ('mail_sent', 'site',
       date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam',
       (date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') + interval '1 month') AT TIME ZONE 'Europe/Amsterdam', 3)`,
  );
  await pingWorkerHealth(workerDb, pinger, logger, { MJK_MAIL_CAP: '5' });
  await admin.query(`UPDATE rate_limit SET count = 4`);
  await pingWorkerHealth(workerDb, pinger, logger, { MJK_MAIL_CAP: '5' });
  await pingWorkerHealth(workerDb, pinger, logger, {});
  expect(pings).toEqual(['success', 'success', 'fail', 'success']);
});
