import { HANDLE_RE, RESERVED_HANDLES, TERMS_VERSION } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite } from '../../src/auth/invite.ts';
import { accountsApp, altchaPayload } from './app.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';

// P2c criterion 9, the database half. P2a's tests already prove: an existing handle at sign-up is a 409
// (signup.int.test.ts), the CHECK refuses 'ABC', 'Abc_def', 'ab', 31 characters and a dash (auth-schema.int.test.ts),
// and 'admin' at sign-up is a 422 (signup.int.test.ts). This file adds every reserved entry and the case collision.

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;

beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('sign-up refuses every reserved handle', () => {
  it('each entry of RESERVED_HANDLES is refused, and no account or mail code follows', async () => {
    // The reserved check runs before the ALTCHA and invite are spent, so one of each serves every attempt.
    const invite = (await createInvite(a.db, t.keys, { maxUses: 1, days: 14 })).code;
    const altcha = await altchaPayload(t.req);
    const before = (await a.admin.query('SELECT count(*)::int AS n FROM email_code')).rows[0]?.n;
    let n = 0;
    for (const handle of RESERVED_HANDLES) {
      n += 1;
      const res = await t.req('/auth/signup', {
        peer: `198.51.100.${n}`,
        body: {
          invite,
          email: `reserved${n}.${process.pid}@example.org`,
          handle,
          display_name: 'Nieuw lid',
          age_confirmed: true,
          terms_version: TERMS_VERSION,
          altcha,
          locale: 'nl',
        },
      });
      // A reserved word that fits HANDLE_RE is a 422; one that does not ('me') never gets past the schema (400).
      expect(res.status, handle).toBe(HANDLE_RE.test(handle) ? 422 : 400);
    }
    expect((await a.admin.query('SELECT count(*)::int AS n FROM email_code')).rows[0]?.n).toBe(before);
    expect(
      (await a.admin.query('SELECT count(*)::int AS n FROM app_user WHERE handle = ANY($1)', [RESERVED_HANDLES]))
        .rows[0]?.n,
    ).toBe(0);
  });
});

describe('case', () => {
  it('a handle differing only in case collides: at sign-up it is not a handle, and in the table it is the same value', async () => {
    const u = await a.newUser({ handle: 'taken_case' });
    // A§10: handles are lower case, so the sign-up schema refuses the upper-case spelling before anything else.
    const invite = (await createInvite(a.db, t.keys, { maxUses: 1, days: 14 })).code;
    const res = await t.req('/auth/signup', {
      body: {
        invite,
        email: `case.${process.pid}@example.org`,
        handle: 'Taken_Case',
        display_name: 'Nieuw lid',
        age_confirmed: true,
        terms_version: TERMS_VERSION,
        altcha: await altchaPayload(t.req),
        locale: 'nl',
      },
    });
    expect(res.status).toBe(400);
    // The column is citext: the upper-case spelling finds the same row (so the unique index sees one value).
    const found = await a.admin.query('SELECT id FROM app_user WHERE handle = $1', ['TAKEN_CASE']);
    expect(found.rows.map((r) => r.id)).toEqual([u.id]);
    // Written directly, the upper-case spelling is refused by the CHECK (23514), the lower-case twin by the unique index (23505).
    const insert = (handle: string) =>
      a.admin
        .query(
          `INSERT INTO app_user (email, email_verified_at, handle, display_name, age_confirmed_at, terms_version, terms_accepted_at)
           VALUES ($1, now(), $2, 'Twin', now(), $3, now())`,
          [`twin.${handle}.${process.pid}@example.org`, handle, TERMS_VERSION],
        )
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code,
        );
    expect(await insert('TAKEN_CASE')).toBe('23514');
    expect(await insert('taken_case')).toBe('23505');
  });
});
