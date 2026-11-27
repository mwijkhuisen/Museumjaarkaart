import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancel, signIn } from '../src/lib/passkey.ts';

// lib/passkey.ts's `signIn` guards (P2b review): an autofill must not start its ceremony (which
// aborts any other) once a modal one began or the screen went away, and no ceremony sends its
// verify call after `cancel()`. The library is mocked; `fetch` is stubbed (msw fails an unhandled
// request), each answer held until the test releases it.

const lib = vi.hoisted(() => ({ startAuthentication: vi.fn(), cancelCeremony: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: lib.startAuthentication,
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => true,
  WebAuthnAbortService: { cancelCeremony: lib.cancelCeremony },
}));

const ID = 'AQIDBAUGBwgJCgsMDQ4PEA';
const B64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString('base64url');
const OPTIONS = { challenge: B64(32, 0x43), rpId: 'mjk.test', timeout: 300_000, userVerification: 'required' };
const ASSERTION: AuthenticationResponseJSON = {
  id: ID,
  rawId: ID,
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: B64(40, 0x44),
    authenticatorData: B64(37, 0x49),
    signature: B64(70, 0x53),
    userHandle: B64(16, 0x55),
  },
};

type Held = { url: string; release: (status: number, body: unknown) => void };
let held: Held[] = [];

beforeEach(() => {
  held = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          held.push({
            url,
            release: (status, body) =>
              resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
          });
        }),
    ),
  );
  lib.startAuthentication.mockImplementation(async () => ASSERTION);
});
afterEach(() => vi.unstubAllGlobals());

const urls = () => held.map((h) => h.url);
const at = (i: number) => {
  const h = held[i];
  if (h === undefined) throw new Error(`no request ${i}`);
  return h;
};
/** Lets the awaited fetch, JSON parse and schema run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const isAbort = (error: unknown) =>
  error instanceof Error &&
  error.name === 'AbortError' &&
  (error as { code?: unknown }).code === 'ERROR_CEREMONY_ABORTED';

describe('signIn', () => {
  it('runs options, the ceremony and the verify call (the baseline the guards below cut short)', async () => {
    const done = signIn('autofill');
    await settle();
    at(0).release(200, OPTIONS);
    await settle();
    expect(lib.startAuthentication).toHaveBeenCalledExactlyOnceWith({ optionsJSON: OPTIONS, useBrowserAutofill: true });
    expect(urls()).toEqual(['/api/v1/auth/passkey/options', '/api/v1/auth/passkey/verify']);
    at(1).release(200, { user: null });
    await expect(done).resolves.toEqual({ user: null });
  });

  it('an autofill whose options arrive after a modal began aborts without starting its ceremony', async () => {
    const autofill = signIn('autofill');
    const autofillResult = autofill.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    const modal = signIn('modal');
    await settle();
    expect(urls()).toEqual(['/api/v1/auth/passkey/options', '/api/v1/auth/passkey/options']);
    at(0).release(200, OPTIONS);
    expect(isAbort(await autofillResult)).toBe(true);
    expect(lib.startAuthentication).not.toHaveBeenCalled();
    // The modal goes on: its own ceremony and verify call.
    at(1).release(200, OPTIONS);
    await settle();
    expect(lib.startAuthentication).toHaveBeenCalledExactlyOnceWith({
      optionsJSON: OPTIONS,
      useBrowserAutofill: false,
    });
    at(2).release(200, { user: null });
    await expect(modal).resolves.toEqual({ user: null });
    // The modal has settled: an autofill starts again.
    const again = signIn('autofill');
    await settle();
    at(3).release(200, OPTIONS);
    await settle();
    expect(lib.startAuthentication).toHaveBeenCalledTimes(2);
    at(4).release(200, { user: null });
    await expect(again).resolves.toEqual({ user: null });
  });

  it.each(['autofill', 'modal'] as const)(
    '%s: cancel() during the options request aborts before the ceremony',
    async (mode) => {
      const done = signIn(mode).then(
        () => 'resolved',
        (e: unknown) => e,
      );
      await settle();
      cancel();
      expect(lib.cancelCeremony).toHaveBeenCalledTimes(1);
      at(0).release(200, OPTIONS);
      expect(isAbort(await done)).toBe(true);
      expect(lib.startAuthentication).not.toHaveBeenCalled();
      expect(urls()).toEqual(['/api/v1/auth/passkey/options']);
    },
  );

  it.each(['autofill', 'modal'] as const)(
    '%s: cancel() after the ceremony resolved sends no verify call',
    async (mode) => {
      let finishCeremony: (value: AuthenticationResponseJSON) => void = () => {};
      lib.startAuthentication.mockImplementation(
        () =>
          new Promise<AuthenticationResponseJSON>((resolve) => {
            finishCeremony = resolve;
          }),
      );
      const done = signIn(mode).then(
        () => 'resolved',
        (e: unknown) => e,
      );
      await settle();
      at(0).release(200, OPTIONS);
      await settle();
      expect(lib.startAuthentication).toHaveBeenCalledTimes(1);
      // The person picked a passkey just as the screen went away.
      cancel();
      finishCeremony(ASSERTION);
      expect(isAbort(await done)).toBe(true);
      expect(urls()).toEqual(['/api/v1/auth/passkey/options']);
    },
  );
});
