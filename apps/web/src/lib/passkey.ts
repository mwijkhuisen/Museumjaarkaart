import {
  Me,
  type PasskeyAssertion,
  type PasskeyAttestation,
  PasskeyItem,
  PasskeyRegisterRequest,
  PasskeyRegistrationOptions,
  PasskeySignInOptions,
  PasskeySignInRequest,
} from '@mjk/contracts';
import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { sendJson } from './api.ts';

// Passkeys in the browser (P2b; A§9). The only module that imports @simplewebauthn/browser, and a
// lazy chunk: components reach it through `import()` inside an effect or a handler, behind
// `import.meta.env.SSR`, so no page without a passkey screen loads it (test/build.test.ts).
//
// The server's request schemas are strict (an unknown key is a 400), while a browser or a password
// manager adds extension outputs of its own, so every answer of the library is projected onto the
// fixed shapes of `@mjk/contracts` before it is sent.

/** The answer of the browser or authenticator is not something the server can use (a missing `userHandle`, another credential type). */
export class PasskeyUnusable extends Error {
  constructor() {
    super('passkey_unusable');
    this.name = 'PasskeyUnusable';
  }
}

/** The error a stale autofill ceremony ends with: the shape the library gives an aborted one. */
function aborted(): Error {
  return Object.assign(new Error('passkey_aborted'), { name: 'AbortError', code: 'ERROR_CEREMONY_ABORTED' });
}

/** A sign-in assertion: only what the server reads. A discoverable credential always has a `userHandle`. */
export function projectAssertion(json: AuthenticationResponseJSON): PasskeyAssertion {
  const { id, rawId, type, response } = json;
  const { clientDataJSON, authenticatorData, signature, userHandle } = response;
  if (type !== 'public-key' || userHandle === undefined || userHandle === '') throw new PasskeyUnusable();
  return { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle } };
}

/** A registration: the attestation, the transports the browser named and `credProps.rk`. */
export function projectAttestation(json: RegistrationResponseJSON): PasskeyAttestation {
  const { id, rawId, type, response, clientExtensionResults } = json;
  if (type !== 'public-key') throw new PasskeyUnusable();
  const transports = (response.transports ?? []).filter((t) => t.length > 0 && t.length <= 32).slice(0, 16);
  const rk = clientExtensionResults.credProps?.rk;
  return {
    id,
    rawId,
    type,
    response: {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
      ...(transports.length === 0 ? {} : { transports }),
    },
    ...(typeof rk === 'boolean' ? { rk } : {}),
  };
}

/** Whether this browser can do WebAuthn at all, and show passkeys in the autofill list of an input. */
export async function support(): Promise<{ webauthn: boolean; autofill: boolean }> {
  const webauthn = browserSupportsWebAuthn();
  if (!webauthn) return { webauthn: false, autofill: false };
  try {
    return { webauthn, autofill: await browserSupportsWebAuthnAutofill() };
  } catch {
    return { webauthn, autofill: false };
  }
}

// An autofill ceremony that is still fetching its options must not start (and so abort another
// ceremony) after a modal one began or after `cancel()`.
let generation = 0;
let modalActive = 0;

/**
 * Sign in with a discoverable passkey: fresh options, the ceremony, the projection, the verify
 * call. `modal` opens the browser's own dialog; `autofill` waits behind an input whose
 * `autocomplete` ends in `webauthn` until the person picks a passkey from the autofill list.
 */
export async function signIn(mode: 'modal' | 'autofill'): Promise<Me> {
  const start = generation;
  if (mode === 'modal') modalActive += 1;
  try {
    const optionsJSON = await sendJson('POST', '/api/v1/auth/passkey/options', undefined, PasskeySignInOptions);
    if (mode === 'autofill' && (generation !== start || modalActive > 0)) throw aborted();
    const assertion = await startAuthentication({ optionsJSON, useBrowserAutofill: mode === 'autofill' });
    const body = PasskeySignInRequest.parse({ credential: projectAssertion(assertion) });
    return await sendJson('POST', '/api/v1/auth/passkey/verify', body, Me);
  } finally {
    if (mode === 'modal') modalActive -= 1;
  }
}

/** Add a passkey to the signed-in account (needs a sign-in within the last 5 minutes: the server answers 403 otherwise). */
export async function register(name?: string): Promise<PasskeyItem> {
  const options = await sendJson('POST', '/api/v1/me/passkeys/options', undefined, PasskeyRegistrationOptions);
  const optionsJSON = {
    ...options,
    excludeCredentials: options.excludeCredentials.map(({ id, type, transports }) => ({
      id,
      type,
      ...(transports === undefined ? {} : { transports }),
    })),
  };
  const attestation = await startRegistration({ optionsJSON });
  const body = PasskeyRegisterRequest.parse({
    credential: projectAttestation(attestation),
    ...(name === undefined || name === '' ? {} : { name }),
  });
  return await sendJson('POST', '/api/v1/me/passkeys', body, PasskeyItem);
}

/** Abort the ceremony in flight (a screen going away) and stop an autofill that has not started yet. */
export function cancel(): void {
  generation += 1;
  WebAuthnAbortService.cancelCeremony();
}
