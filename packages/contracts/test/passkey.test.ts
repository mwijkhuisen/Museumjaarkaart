import { describe, expect, it } from 'vitest';
import {
  isCanonicalBase64url,
  PASSKEY_MAX,
  PasskeyItem,
  PasskeyList,
  PasskeyReauthOptions,
  PasskeyReauthRequest,
  PasskeyRegisterRequest,
  PasskeyRegistrationOptions,
  PasskeyRenameRequest,
  PasskeySignInOptions,
  PasskeySignInRequest,
} from '../src/index.ts';

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('base64url');
const id = b64(Array.from({ length: 16 }, (_, i) => i + 1));

const assertion = {
  id,
  rawId: id,
  type: 'public-key',
  response: {
    clientDataJSON: b64(Buffer.from('{"type":"webauthn.get"}')),
    authenticatorData: b64(new Uint8Array(37)),
    signature: b64(new Uint8Array(70)),
    userHandle: b64(new Uint8Array(16)),
  },
};

const attestation = {
  id,
  rawId: id,
  type: 'public-key',
  response: {
    clientDataJSON: b64(Buffer.from('{"type":"webauthn.create"}')),
    attestationObject: b64(new Uint8Array(200)),
    transports: ['internal', 'hybrid'],
  },
  rk: true,
};

describe('isCanonicalBase64url', () => {
  it('accepts the one spelling of every byte string', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(isCanonicalBase64url(b64(bytes))).toBe(true);
    }
  });

  it('refuses padding, the standard alphabet, a lone last character and set unused bits', () => {
    expect(isCanonicalBase64url('AAE=')).toBe(false);
    expect(isCanonicalBase64url('ab+/')).toBe(false);
    expect(isCanonicalBase64url('AAAAA')).toBe(false);
    // "AB" decodes to 0x00 with spare bits set: the canonical spelling of that byte is "AA".
    expect(isCanonicalBase64url('AB')).toBe(false);
    expect(isCanonicalBase64url('AAB')).toBe(false);
    expect(isCanonicalBase64url('AA ')).toBe(false);
  });
});

describe('PasskeySignInRequest', () => {
  it('takes the projected assertion', () => {
    expect(PasskeySignInRequest.parse({ credential: assertion })).toEqual({ credential: assertion });
  });

  it('is strict: an extension output, a missing userHandle or another type is a 400', () => {
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, clientExtensionResults: {} } }).success).toBe(
      false,
    );
    const { userHandle: _, ...noHandle } = assertion.response;
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, response: noHandle } }).success).toBe(false);
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, type: 'password' } }).success).toBe(false);
    expect(PasskeySignInRequest.safeParse({ credential: assertion, extra: 1 }).success).toBe(false);
  });

  it('needs id equal to rawId, and canonical bytes everywhere', () => {
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, rawId: b64([9, 9, 9]) } }).success).toBe(false);
    const padded = { ...assertion.response, signature: `${assertion.response.signature}=` };
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, response: padded } }).success).toBe(false);
    const empty = { ...assertion.response, userHandle: '' };
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, response: empty } }).success).toBe(false);
  });

  it('caps every field: a credential id over 1,023 bytes, a user handle over 64', () => {
    const long = b64(new Uint8Array(1024));
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, id: long, rawId: long } }).success).toBe(false);
    const big = { ...assertion.response, userHandle: b64(new Uint8Array(65)) };
    expect(PasskeySignInRequest.safeParse({ credential: { ...assertion, response: big } }).success).toBe(false);
  });
});

describe('PasskeyRegisterRequest and PasskeyRenameRequest', () => {
  it('take the projected attestation and an optional plain-text name', () => {
    expect(PasskeyRegisterRequest.parse({ credential: attestation }).credential.rk).toBe(true);
    expect(PasskeyRegisterRequest.parse({ credential: attestation, name: ' Laptop ' }).name).toBe('Laptop');
  });

  it('refuse a control or bidi character, 51 code points, an unknown key', () => {
    for (const name of ['a\u{0007}b', 'a\u{202E}b', 'x'.repeat(51), '']) {
      expect(PasskeyRenameRequest.safeParse({ name }).success).toBe(false);
    }
    expect(
      PasskeyRegisterRequest.safeParse({ credential: { ...attestation, clientExtensionResults: {} } }).success,
    ).toBe(false);
  });
});

describe('the answers', () => {
  it('sign-in options carry no credential list and require user verification', () => {
    const ok = { challenge: b64(new Uint8Array(54)), rpId: 'mjk.test', timeout: 300_000, userVerification: 'required' };
    expect(PasskeySignInOptions.parse(ok)).toEqual(ok);
    expect(PasskeySignInOptions.safeParse({ ...ok, allowCredentials: [] }).success).toBe(false);
    expect(PasskeySignInOptions.safeParse({ ...ok, userVerification: 'preferred' }).success).toBe(false);
  });

  it('registration options pin attestation none, resident keys and user verification', () => {
    const ok = {
      challenge: b64(new Uint8Array(54)),
      rp: { id: 'mjk.test', name: 'mjk.test' },
      user: { id: b64(new Uint8Array(16)), name: 'anna', displayName: 'anna' },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      timeout: 300_000,
      attestation: 'none',
      excludeCredentials: [{ id, type: 'public-key', transports: ['internal'] }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      extensions: { credProps: true },
    };
    expect(PasskeyRegistrationOptions.parse(ok)).toEqual(ok);
    expect(PasskeyRegistrationOptions.safeParse({ ...ok, attestation: 'direct' }).success).toBe(false);
    const preferred = { ...ok.authenticatorSelection, residentKey: 'preferred' };
    expect(PasskeyRegistrationOptions.safeParse({ ...ok, authenticatorSelection: preferred }).success).toBe(false);
  });

  it('a list item never has a key, an id, transports or a counter', () => {
    const item = {
      ref: '0196f7a4-0000-7000-8000-000000000001',
      name: null,
      created_at: '2026-11-27T10:00:00.000Z',
      last_used_at: null,
      backed_up: true,
    };
    expect(PasskeyItem.parse(item)).toEqual(item);
    for (const extra of ['public_key', 'credential_id', 'transports', 'sign_count']) {
      expect(PasskeyItem.safeParse({ ...item, [extra]: 'x' }).success).toBe(false);
    }
    expect(PasskeyList.safeParse({ items: Array.from({ length: PASSKEY_MAX + 1 }, () => item) }).success).toBe(false);
  });
});

describe('re-authentication', () => {
  it('takes an assertion with or without userHandle, and stays strict otherwise', () => {
    expect(PasskeyReauthRequest.safeParse({ credential: assertion }).success).toBe(true);
    const { userHandle: _, ...noHandle } = assertion.response;
    expect(PasskeyReauthRequest.safeParse({ credential: { ...assertion, response: noHandle } }).success).toBe(true);
    expect(PasskeyReauthRequest.safeParse({ credential: { ...assertion, clientExtensionResults: {} } }).success).toBe(
      false,
    );
    const empty = { ...assertion.response, userHandle: '' };
    expect(PasskeyReauthRequest.safeParse({ credential: { ...assertion, response: empty } }).success).toBe(false);
  });

  it('its options name at least one of the member\u2019s credentials, at most PASSKEY_MAX', () => {
    const ok = {
      challenge: b64(new Uint8Array(54)),
      rpId: 'mjk.test',
      timeout: 300_000,
      userVerification: 'required',
      allowCredentials: [{ id, type: 'public-key', transports: ['internal'] }],
    };
    expect(PasskeyReauthOptions.parse(ok)).toEqual(ok);
    expect(PasskeyReauthOptions.safeParse({ ...ok, allowCredentials: [] }).success).toBe(false);
    const many = Array.from({ length: PASSKEY_MAX + 1 }, () => ({ id, type: 'public-key' }));
    expect(PasskeyReauthOptions.safeParse({ ...ok, allowCredentials: many }).success).toBe(false);
  });
});
