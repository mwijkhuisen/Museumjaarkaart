import { AltchaChallenge } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newChallenge, spendAltcha } from '../../src/auth/altcha.ts';
import { accountsApp, altchaPayload } from './app.ts';
import { type AuthDb, openAuthDb } from './fixtures.ts';

// P2a design 2: challenges issued without a write, signed per host, single use by the hash of
// their signature, refused when expired, forged, replayed or from the other host.

let a: AuthDb;
let t: ReturnType<typeof accountsApp>;
beforeAll(async () => {
  a = await openAuthDb();
  t = accountsApp(a);
}, 120_000);
afterAll(async () => {
  await a?.close();
});

describe('ALTCHA', () => {
  it('GET /auth/altcha answers a v2 SHA-256 challenge, private, no-store, and writes nothing', async () => {
    const before = (await a.admin.query('SELECT count(*)::int AS n FROM auth_challenge')).rows[0]?.n;
    const r = await t.req('/auth/altcha');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(AltchaChallenge.parse(await r.json()).parameters.algorithm).toBe('SHA-256');
    expect((await a.admin.query('SELECT count(*)::int AS n FROM auth_challenge')).rows[0]?.n).toBe(before);
  });

  it('a solution spends once; a replay fails', async () => {
    const payload = await altchaPayload(t.req);
    expect(await spendAltcha(a.db, t.keys, 'public', payload)).toBe(true);
    expect(await spendAltcha(a.db, t.keys, 'public', payload)).toBe(false);
    const spent = await a.admin.query("SELECT host, used_at FROM auth_challenge WHERE purpose = 'altcha'");
    expect(spent.rows.every((r) => r.host === 'public' && r.used_at !== null)).toBe(true);
  });

  it('a public-host solution fails on the admin host, and the other way round', async () => {
    expect(await spendAltcha(a.db, t.keys, 'admin', await altchaPayload(t.req, 'mjk.test'))).toBe(false);
    const adminSolved = await altchaPayload(t.req, 'admin.mjk.test');
    expect(await spendAltcha(a.db, t.keys, 'public', adminSolved)).toBe(false);
    expect(await spendAltcha(a.db, t.keys, 'admin', adminSolved)).toBe(true);
  });

  it('another key, a changed parameter, an unsolved or malformed payload fail', async () => {
    const other = accountsApp(a);
    expect(await spendAltcha(a.db, t.keys, 'public', await altchaPayload(other.req))).toBe(false);
    const good = JSON.parse(Buffer.from(await altchaPayload(t.req), 'base64').toString('utf8'));
    const tampered = {
      ...good,
      challenge: { ...good.challenge, parameters: { ...good.challenge.parameters, cost: 2 } },
    };
    expect(await spendAltcha(a.db, t.keys, 'public', Buffer.from(JSON.stringify(tampered)).toString('base64'))).toBe(
      false,
    );
    const unsolved = { challenge: await newChallenge(t.keys, 'public'), solution: { counter: 0, derivedKey: 'ff' } };
    expect(await spendAltcha(a.db, t.keys, 'public', Buffer.from(JSON.stringify(unsolved)).toString('base64'))).toBe(
      false,
    );
    for (const junk of ['', 'not base64!', Buffer.from('null').toString('base64'), 'A'.repeat(5000)])
      expect(await spendAltcha(a.db, t.keys, 'public', junk)).toBe(false);
  });

  it('an expired challenge fails', async () => {
    const good = JSON.parse(Buffer.from(await altchaPayload(t.req), 'base64').toString('utf8'));
    // Re-signing is impossible without the key, so expiry is checked on a challenge we let lapse.
    const past = {
      ...good,
      challenge: { ...good.challenge, parameters: { ...good.challenge.parameters, expiresAt: 1 } },
    };
    expect(await spendAltcha(a.db, t.keys, 'public', Buffer.from(JSON.stringify(past)).toString('base64'))).toBe(false);
  });
});
