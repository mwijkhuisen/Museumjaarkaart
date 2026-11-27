import { PasskeyRegisterRequest, PasskeySignInRequest } from '@mjk/contracts';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import { describe, expect, it } from 'vitest';
import { PasskeyUnusable, projectAssertion, projectAttestation } from '../src/lib/passkey.ts';

// The projection of the library's answers onto the server's strict request schemas (P2b). Bytes are
// canonical base64url, as the library produces them.

const ID = 'AQIDBAUGBwgJCgsMDQ4PEA';
const CLIENT_DATA = 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0';
// Built, not written out: a long base64url literal next to a field name reads as a key to gitleaks.
const DATA = Buffer.alloc(37, 0x49).toString('base64url');

const assertion = (patch: Record<string, unknown> = {}): AuthenticationResponseJSON => ({
  id: ID,
  rawId: ID,
  type: 'public-key',
  authenticatorAttachment: 'platform',
  clientExtensionResults: { appid: true, credProps: { rk: true } },
  response: {
    clientDataJSON: CLIENT_DATA,
    authenticatorData: DATA,
    signature: 'MEUCIQDh',
    userHandle: 'dXNlci1oYW5kbGU',
    ...patch,
  } as AuthenticationResponseJSON['response'],
});

const attestation = (
  response: Record<string, unknown> = {},
  extensions: RegistrationResponseJSON['clientExtensionResults'] = { credProps: { rk: true } },
): RegistrationResponseJSON => ({
  id: ID,
  rawId: ID,
  type: 'public-key',
  authenticatorAttachment: 'cross-platform',
  clientExtensionResults: extensions,
  response: {
    clientDataJSON: CLIENT_DATA,
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal', 'hybrid'],
    publicKeyAlgorithm: -7,
    publicKey: 'MFkwEwYH',
    authenticatorData: DATA,
    ...response,
  } as RegistrationResponseJSON['response'],
});

describe('projectAssertion', () => {
  it('keeps exactly the five fields the server reads and drops everything a browser or password manager adds', () => {
    const projected = projectAssertion({
      ...assertion(),
      // A password manager's own field, at the top and inside the response.
      ...({ vendorExtra: 'x' } as object),
    } as AuthenticationResponseJSON);
    expect(projected).toEqual({
      id: ID,
      rawId: ID,
      type: 'public-key',
      response: {
        clientDataJSON: CLIENT_DATA,
        authenticatorData: DATA,
        signature: 'MEUCIQDh',
        userHandle: 'dXNlci1oYW5kbGU',
      },
    });
    const withExtraResponseKey = assertion();
    Object.assign(withExtraResponseKey.response, { extra: 1 });
    expect(Object.keys(projectAssertion(withExtraResponseKey).response).sort()).toEqual([
      'authenticatorData',
      'clientDataJSON',
      'signature',
      'userHandle',
    ]);
  });

  it('parses with the strict request schema', () => {
    expect(PasskeySignInRequest.safeParse({ credential: projectAssertion(assertion()) }).success).toBe(true);
  });

  it('refuses a missing or empty userHandle and another credential type', () => {
    expect(() => projectAssertion(assertion({ userHandle: undefined }))).toThrow(PasskeyUnusable);
    expect(() => projectAssertion(assertion({ userHandle: '' }))).toThrow(PasskeyUnusable);
    expect(() => projectAssertion({ ...assertion(), type: 'other' as 'public-key' })).toThrow(PasskeyUnusable);
  });

  it('names the failure PasskeyUnusable, whatever the message', () => {
    try {
      projectAssertion(assertion({ userHandle: undefined }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('PasskeyUnusable');
    }
  });
});

describe('projectAttestation', () => {
  it('keeps the attestation, the transports and credProps.rk, and drops the rest', () => {
    expect(projectAttestation(attestation())).toEqual({
      id: ID,
      rawId: ID,
      type: 'public-key',
      response: {
        clientDataJSON: CLIENT_DATA,
        attestationObject: 'o2NmbXRkbm9uZQ',
        transports: ['internal', 'hybrid'],
      },
      rk: true,
    });
  });

  it('carries rk false, and leaves rk out when the browser did not report it', () => {
    expect(projectAttestation(attestation({}, { credProps: { rk: false } })).rk).toBe(false);
    expect('rk' in projectAttestation(attestation({}, {}))).toBe(false);
    expect('rk' in projectAttestation(attestation({}, { credProps: {} }))).toBe(false);
  });

  it('leaves transports out when there are none, and drops an unusable entry', () => {
    expect('transports' in projectAttestation(attestation({ transports: [] })).response).toBe(false);
    expect('transports' in projectAttestation(attestation({ transports: undefined })).response).toBe(false);
    const odd = projectAttestation(attestation({ transports: ['usb', '', 'x'.repeat(33)] }));
    expect(odd.response.transports).toEqual(['usb']);
  });

  it('parses with the strict request schema, with and without a name', () => {
    const credential = projectAttestation(attestation());
    expect(PasskeyRegisterRequest.safeParse({ credential }).success).toBe(true);
    expect(PasskeyRegisterRequest.safeParse({ credential, name: 'Telefoon' }).success).toBe(true);
    // The unprojected library answer is exactly what the strict schema refuses.
    expect(PasskeyRegisterRequest.safeParse({ credential: attestation() }).success).toBe(false);
  });

  it('refuses another credential type', () => {
    expect(() => projectAttestation({ ...attestation(), type: 'other' as 'public-key' })).toThrow(PasskeyUnusable);
  });
});
