import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open } from '../../src/auth/crypto.ts';
import { readAppKeys } from '../../src/auth/keys.ts';
import { aad } from '../../src/mail/payloads.ts';
import { type Harness, openHarness } from './harness.ts';

// `admin invite create` as mjk_api (A§9): the code is shown once and stored only as an HMAC.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  await h?.close();
});

const count = async (table: string) =>
  Number((await h.api.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
const CODE = /^invite ([0-9A-HJKMNP-TV-Z]{16}) valid until (\d{4}-\d{2}-\d{2}) \((\d+) uses?\)$/;

describe('invite create', () => {
  it('prints the code once; the row holds only its HMAC; one audit row without secrets', async () => {
    const inv0 = await count('invite');
    const aud0 = await count('audit_log');
    const r = await h.admin('invite', 'create', '--uses', '3', '--days', '7', '--note', 'for a friend');
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    const m = CODE.exec(r.out[0] as string);
    expect(m).not.toBeNull();
    const code = m?.[1] as string;
    expect(m?.[3]).toBe('3');

    const { rows } = await h.api.query<{ j: string; max_uses: number; days: number; code_hmac: Buffer }>(
      `SELECT row_to_json(i)::text AS j, max_uses, code_hmac,
              extract(day FROM expires_at - now())::int AS days
         FROM invite i ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.j).not.toContain(code);
    expect(rows[0]?.max_uses).toBe(3);
    expect(rows[0]?.days).toBe(6); // 7 days minus the moment since
    expect(rows[0]?.code_hmac).toHaveLength(32);
    expect(m?.[2]).toBe(
      (await h.api.query<{ d: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM invite`))
        .rows[0]?.d,
    );

    expect(await count('invite')).toBe(inv0 + 1);
    expect(await count('audit_log')).toBe(aud0 + 1);
    const a = (await h.api.query<{ j: string }>('SELECT row_to_json(a)::text AS j FROM audit_log a ORDER BY id DESC'))
      .rows[0] as { j: string };
    const audit = JSON.parse(a.j);
    expect(audit).toMatchObject({
      actor_kind: 'admin',
      actor_id: null,
      action: 'invite.create',
      target_kind: 'invite',
      detail: { max_uses: 3, days: 7, mailed: false },
    });
    expect(a.j).not.toContain(code);
    expect(a.j).not.toContain('friend');
  });

  it('defaults to one use for 14 days', async () => {
    const r = await h.admin('invite', 'create');
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/\(1 use\)$/);
  });

  it('with --email queues a mail_invite job whose sealed fields open with the keys', async () => {
    const jobs0 = await count('job');
    const r = await h.admin('invite', 'create', '--email', ' Friend@Example.com ', '--locale', 'en');
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(2);
    const code = CODE.exec(r.out[0] as string)?.[1] as string;
    expect(r.out.join('\n')).not.toMatch(/example\.com/i);
    expect(await count('job')).toBe(jobs0 + 1);

    const { rows } = await h.api.query<{ payload: Record<string, string>; text: string }>(
      `SELECT payload, payload::text AS text FROM job WHERE kind = 'mail_invite'`,
    );
    const p = rows[0]?.payload as Record<string, string>;
    expect(rows[0]?.text).not.toContain(code);
    expect(rows[0]?.text).not.toMatch(/example\.com/i);
    expect(p.locale).toBe('en');
    const keys = readAppKeys(h.keysDir);
    if (typeof keys === 'string') throw new Error(keys);
    const id = p.invite_id as string;
    expect(open(keys.code_seal, p.sealed_code as string, aad.inviteCode(id))).toBe(code);
    expect(open(keys.code_seal, p.sealed_to as string, aad.inviteTo(id))).toBe('friend@example.com');

    const a = (await h.api.query<{ j: string }>('SELECT row_to_json(a)::text AS j FROM audit_log a ORDER BY id DESC'))
      .rows[0] as { j: string };
    expect(JSON.parse(a.j).detail).toEqual({ max_uses: 1, days: 14, mailed: true });
    expect(a.j).not.toMatch(/example\.com/i);
    expect(a.j).not.toContain(code);
  });

  it.each([
    [['--uses', '0']],
    [['--uses', '1001']],
    [['--uses', '1.5']],
    [['--uses', 'x']],
    [['--days', '0']],
    [['--days', '366']],
    [['--email', 'not-an-email']],
    [['--locale', 'de']],
    [['--note', 'mail me at a@b.nl']],
    [['--note', 'x'.repeat(201)]],
    [['--note', 'line\nbreak']],
    [['--bogus', 'x']],
    [['extra']],
  ])('bad input %j exits 64 and writes nothing', async (args) => {
    const inv0 = await count('invite');
    const aud0 = await count('audit_log');
    const r = await h.admin('invite', 'create', ...args);
    expect(r.code).toBe(64);
    expect(r.out).toEqual([]);
    expect(await count('invite')).toBe(inv0);
    expect(await count('audit_log')).toBe(aud0);
  });

  it('a missing or malformed app_keys exits 78 and prints no value', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mjk-nokeys-'));
    const missing = await h.adminWith(empty, 'invite', 'create');
    expect(missing).toEqual({ code: 78, out: [], err: ['admin: app_keys: unreadable'] });

    const bad = mkdtempSync(join(tmpdir(), 'mjk-badkeys-'));
    writeFileSync(join(bad, 'app_keys'), 'otp_pepper=short\n');
    const r = await h.adminWith(bad, 'invite', 'create');
    expect(r).toEqual({ code: 78, out: [], err: ['admin: app_keys: line 1 malformed'] });
  });
});
