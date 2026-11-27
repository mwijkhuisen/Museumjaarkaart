import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/log.ts';
import { purge } from '../../src/worker/purge.ts';
import { type AuthDb, openAuthDb } from '../auth/fixtures.ts';

let a: AuthDb;
beforeAll(async () => {
  a = await openAuthDb();
});
afterAll(async () => {
  await a.close();
});

const q = (text: string, values: unknown[] = []) => a.admin.query(text, values);
const count = async (table: string) => Number((await q(`SELECT count(*) FROM ${table}`)).rows[0].count);
const ago = (i: string) => `now() - interval '${i}'`;
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const mailJob = async (kind: string, state: string, payload: object, age: string) =>
  (
    await q(
      `INSERT INTO job (kind, state, payload, created_at, finished_at)
       VALUES ($1, $2, $3, now() - $4::interval, CASE WHEN $2 IN ('done','failed') THEN now() ELSE NULL END) RETURNING id`,
      [kind, state, JSON.stringify(payload), age],
    )
  ).rows[0].id as string;
const payloadOf = async (id: string) => (await q('SELECT payload FROM job WHERE id = $1', [id])).rows[0].payload;

it('purges every table at its limit, keeps what is inside it, and is idempotent', async () => {
  const u = await a.newUser();
  const sess = (n: string, exp: string, abs: string) =>
    q(
      `INSERT INTO session (id, user_id, host, method, expires_at, absolute_expires_at)
       VALUES (decode(repeat($1, 32), 'hex'), $2, 'public', 'code', ${exp}, ${abs})`,
      [n, u.id],
    );
  await sess('01', ago('2 days'), ago('1 minute')); // both expired
  await sess('02', ago('1 minute'), `now() + interval '1 day'`); // idle expired only
  await sess('03', `now() + interval '1 minute'`, `now() + interval '1 day'`); // live

  const code = (age: string) =>
    q(
      `INSERT INTO email_code (email, purpose, code_hmac, expires_at, created_at)
       VALUES ('x@example.org', 'signin', decode(repeat('ab', 32), 'hex'), now() + interval '1 day', now() - $1::interval)`,
      [age],
    );
  await code('24 hours 1 minute');
  await code('23 hours 59 minutes');

  let h = 0;
  const chal = (exp: string) =>
    q(
      `INSERT INTO auth_challenge (purpose, host, value_hash, expires_at)
       VALUES ('altcha', 'public', decode(lpad($1, 64, '0'), 'hex'), ${exp})`,
      [(++h).toString(16)],
    );
  await chal(ago('61 seconds')); // past the minute of grace (P2b review L4)
  await chal(ago('59 seconds')); // expired, inside the grace: kept
  await chal(`now() + interval '1 minute'`);

  const rl = (key: string, end: string) =>
    q(
      `INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
       VALUES ('b', $1, now() - interval '3 days', ${end}, 1)`,
      [key],
    );
  await rl('old', ago('24 hours 1 minute'));
  await rl('new', ago('23 hours'));

  const job = (state: string, age: string) =>
    q(`INSERT INTO job (kind, state, finished_at) VALUES ('x', $1, now() - $2::interval)`, [state, age]);
  await job('done', '30 days 1 minute');
  await job('failed', '30 days 1 minute');
  await job('done', '29 days');
  await q(`INSERT INTO job (kind, state, created_at) VALUES ('x', 'queued', now() - interval '60 days')`);

  let ih = 0;
  const inv = (exp: string, uses: number, used: string) =>
    q(
      `INSERT INTO invite (code_hmac, max_uses, uses, expires_at, used_at)
       VALUES (decode(lpad($1, 64, '0'), 'hex'), 1, $2, ${exp}, ${used})`,
      [(++ih).toString(16), uses],
    );
  await inv(ago('90 days 1 minute'), 0, 'NULL'); // expired long ago
  await inv(ago('89 days'), 0, 'NULL'); // inside
  await inv(`now() + interval '1 day'`, 1, ago('90 days 1 minute')); // used up long ago
  await inv(`now() + interval '1 day'`, 1, ago('89 days')); // used up recently
  await inv(`now() + interval '1 day'`, 0, ago('91 days')); // not used up: stays

  const ip = (age: string) =>
    q(
      `INSERT INTO content_ip_log (user_id, target_kind, target_id, ip, created_at)
       VALUES (NULL, 'review', uuidv7(), '192.0.2.1', now() - $1::interval)`,
      [age],
    );
  await ip('30 days 1 minute');
  await ip('29 days');

  await q(`INSERT INTO audit_log (at, actor_kind, action) VALUES (now() - interval '5 years', 'system', 'x.y')`);

  const lines: unknown[] = [];
  const logger: Logger = {
    ...quiet,
    info: (f, msg) => {
      expect(msg).toBe('purge_done');
      lines.push(f);
    },
  };
  const counts = await purge(a.worker, logger);
  expect(counts).toMatchObject({
    session: 2,
    email_code: 1,
    auth_challenge: 1,
    rate_limit: 1,
    job: 2,
    invite: 2,
    content_ip_log: 1,
  });
  expect(lines).toEqual([counts]);
  expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true);

  expect(await count('session')).toBe(1);
  expect(await count('email_code')).toBe(1);
  expect(await count('auth_challenge')).toBe(2);
  expect(await count('rate_limit')).toBe(1);
  expect((await q(`SELECT state FROM job WHERE kind = 'x' ORDER BY state`)).rows.map((r) => r.state)).toEqual([
    'done',
    'queued',
  ]);
  expect(await count('invite')).toBe(3);
  expect(await count('content_ip_log')).toBe(1);
  expect(await count('audit_log')).toBe(1);

  const again = await purge(a.worker, quiet);
  expect(Object.values(again).every((n) => n === 0)).toBe(true);
});

it('nulls sealed values of expired or failed mail jobs, keeps the other keys, never touches a running job', async () => {
  const base = { email_code_id: 'c', locale: 'nl' };
  const old = await mailJob('mail_code', 'queued', { ...base, sealed: 'S' }, '11 minutes');
  const young = await mailJob('mail_code', 'queued', { ...base, sealed: 'S' }, '9 minutes');
  const failedYoung = await mailJob('mail_code', 'failed', { ...base, sealed: 'S' }, '1 minute');
  const running = await mailJob('mail_code', 'running', { ...base, sealed: 'S' }, '1 hour');
  const inv = await mailJob('mail_invite', 'failed', { sealed_code: 'A', sealed_to: 'B', invite_id: 'i' }, '1 minute');
  const note = await mailJob('mail_notice', 'failed', { sealed_to: 'B', user_id: 'u', locale: 'en' }, '1 minute');
  const queuedInv = await mailJob(
    'mail_invite',
    'queued',
    { sealed_code: 'A', sealed_to: 'B', invite_id: 'i' },
    '1 hour',
  );
  const runningInv = await mailJob(
    'mail_invite',
    'running',
    { sealed_code: 'A', sealed_to: 'B', invite_id: 'i' },
    '1 hour',
  );

  const counts = await purge(a.worker, quiet);
  expect(counts.sealed_code).toBe(2);
  expect(counts.sealed_failed).toBe(2);
  expect(await payloadOf(old)).toEqual({ ...base, sealed: null });
  expect(await payloadOf(young)).toEqual({ ...base, sealed: 'S' });
  expect(await payloadOf(failedYoung)).toEqual({ ...base, sealed: null });
  expect(await payloadOf(running)).toEqual({ ...base, sealed: 'S' });
  expect(await payloadOf(inv)).toEqual({ sealed_code: null, sealed_to: null, invite_id: 'i' });
  expect(await payloadOf(note)).toEqual({ sealed_to: null, user_id: 'u', locale: 'en' });
  expect(await payloadOf(queuedInv)).toEqual({ sealed_code: 'A', sealed_to: 'B', invite_id: 'i' });
  expect(await payloadOf(runningInv)).toEqual({ sealed_code: 'A', sealed_to: 'B', invite_id: 'i' });

  const again = await purge(a.worker, quiet);
  expect(again.sealed_code).toBe(0);
  expect(again.sealed_failed).toBe(0);
});
