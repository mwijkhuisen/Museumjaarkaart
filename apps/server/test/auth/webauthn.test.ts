import { describe, expect, it } from 'vitest';
import { hmac } from '../../src/auth/crypto.ts';
import {
  ADD_REAUTH_S,
  checkChallenge,
  counterRefused,
  knownTransports,
  mintChallenge,
  originOf,
  rpIdOf,
  WEBAUTHN_TTL_S,
} from '../../src/auth/webauthn.ts';
import { makeTestKeys } from './test-keys.ts';

// P2b: the stateless challenge, the counter rule and the small helpers of auth/webauthn.ts.

const keys = makeTestKeys();
const NOW = 1_800_000_000;
const SITE = { domain: 'mjk.test', adminHost: 'admin.mjk.test' };
const b64 = (b: Buffer) => b.toString('base64url');

describe('the challenge', () => {
  it('is 54 bytes, base64url without padding, and different every time', () => {
    const a = mintChallenge(keys, 'public', 'signin', [], NOW);
    const b = mintChallenge(keys, 'public', 'signin', [], NOW);
    expect(a).toHaveLength(54);
    expect(b64(a)).toMatch(/^[A-Za-z0-9_-]{72}$/);
    expect(a.equals(b)).toBe(false);
  });

  it('checks for its own host, kind and binding until it expires', () => {
    const c = b64(mintChallenge(keys, 'public', 'register', ['user', 'ref'], NOW));
    const ok = checkChallenge(keys, 'public', 'register', ['user', 'ref'], c, NOW + WEBAUTHN_TTL_S - 1);
    expect(ok?.expS).toBe(NOW + WEBAUTHN_TTL_S);
    expect(ok?.bytes.equals(Buffer.from(c, 'base64url'))).toBe(true);
    // the other host, the other ceremony, another session or user, another key: never
    expect(checkChallenge(keys, 'admin', 'register', ['user', 'ref'], c, NOW)).toBeNull();
    expect(checkChallenge(keys, 'public', 'signin', ['user', 'ref'], c, NOW)).toBeNull();
    expect(checkChallenge(keys, 'public', 'register', ['user', 'other'], c, NOW)).toBeNull();
    expect(checkChallenge(keys, 'public', 'register', ['other', 'ref'], c, NOW)).toBeNull();
    expect(checkChallenge(keys, 'public', 'register', ['userref'], c, NOW)).toBeNull();
    expect(checkChallenge(makeTestKeys(), 'public', 'register', ['user', 'ref'], c, NOW)).toBeNull();
    // expired by the process clock
    expect(checkChallenge(keys, 'public', 'register', ['user', 'ref'], c, NOW + WEBAUTHN_TTL_S)).toBeNull();
  });

  it('refuses a forged, truncated, extended, re-spelled or tampered challenge', () => {
    const bytes = mintChallenge(keys, 'admin', 'signin', [], NOW);
    const check = (s: string) => checkChallenge(keys, 'admin', 'signin', [], s, NOW);
    expect(check(b64(bytes))).not.toBeNull();
    expect(check(b64(bytes.subarray(0, 53)))).toBeNull();
    expect(check(b64(Buffer.concat([bytes, Buffer.from([0])])))).toBeNull();
    expect(check(`${b64(bytes)}=`)).toBeNull();
    // Standard base64: a challenge whose spelling has a `+` or `/` (one in ten has neither, and is then
    // the same string as its base64url).
    let std = bytes;
    while (std.toString('base64') === b64(std)) std = mintChallenge(keys, 'admin', 'signin', [], NOW);
    expect(check(b64(std))).not.toBeNull();
    expect(check(std.toString('base64'))).toBeNull();
    for (const at of [0, 1, 2, 5, 6, 21, 22, 53]) {
      const t = Buffer.from(bytes);
      t[at] = (t[at] as number) ^ 0x01;
      expect(check(b64(t)), `byte ${at}`).toBeNull();
    }
    // a later expiry with the old tag
    const later = Buffer.from(bytes);
    later.writeUInt32BE(NOW + 10_000, 2);
    expect(check(b64(later))).toBeNull();
    expect(check('')).toBeNull();
    expect(check('x'.repeat(72))).toBeNull();
  });

  it('carries its version inside the tag: a tag made without the version part is refused', () => {
    const bytes = mintChallenge(keys, 'public', 'signin', [], NOW);
    const expNonce = bytes.subarray(2, 22);
    const check = (tag: Buffer) =>
      checkChallenge(keys, 'public', 'signin', [], b64(Buffer.concat([bytes.subarray(0, 22), tag])), NOW);
    expect(check(hmac(keys.altcha_hmac, 'webauthn', '1', 'public', '1', expNonce))).not.toBeNull();
    // the pre-review layout, which left the version byte outside the MAC
    expect(check(hmac(keys.altcha_hmac, 'webauthn', 'public', '1', expNonce))).toBeNull();
    expect(check(hmac(keys.altcha_hmac, 'webauthn', '2', 'public', '1', expNonce))).toBeNull();
  });
});

describe('the counter rule (the library’s, applied after the signature)', () => {
  it.each([
    [0, 0, false], // a counterless authenticator (synced passkeys report 0)
    [1, 0, false],
    [6, 5, false],
    [5, 5, true], // an equal non-zero counter is refused, as the library does
    [3, 5, true],
    [0, 5, true], // back to 0 after counting
  ])('next %i over stored %i → refused %s', (next, stored, refused) => {
    expect(counterRefused(next, stored)).toBe(refused);
  });
});

describe('helpers', () => {
  it('keeps only the transports WebAuthn names, once each, at most 8', () => {
    expect(knownTransports(['internal', 'hybrid', 'internal', 'carrier-pigeon', 'USB', 'usb'])).toEqual([
      'internal',
      'hybrid',
      'usb',
    ]);
    expect(knownTransports(undefined)).toEqual([]);
  });

  it('one RP ID for both hosts, and one origin per host', () => {
    expect(rpIdOf(SITE)).toBe('mjk.test');
    expect(originOf(SITE, 'public')).toBe('https://mjk.test');
    expect(originOf(SITE, 'admin')).toBe('https://admin.mjk.test');
  });

  it('adding a passkey starts within 5 minutes of a sign-in (Q1a)', () => {
    expect(ADD_REAUTH_S).toBe(300);
  });
});
