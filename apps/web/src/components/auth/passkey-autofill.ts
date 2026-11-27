import type { Me } from '@mjk/contracts';
import { isCeremonyAborted } from './errors.ts';

// The two passkey ceremonies of the sign-in page (P2b; A§9), without React: PasskeySignIn.tsx only
// wires this to its state, and test/passkey-autofill.test.ts drives it with fake promises and timers.
//
//  - autofill ("conditional UI"): `start()` arms it once the browser supports it. It waits behind the
//    `webauthn` input until the person picks a passkey from the browser's list. The server's
//    challenge lives 300 s, so it is armed again with fresh options every `rearmMs`.
//  - `modal()`: the button. Its ceremony aborts the pending autofill through the library's shared
//    abort controller (lib/passkey.ts holds back one still fetching its options), and that autofill
//    rejects as aborted. An aborted autofill is never re-armed from its rejection (that would abort
//    the modal in turn): the autofill is armed again once the modal run has settled.
//  - Any other autofill failure re-arms straight away, so the list works again at once, and shows
//    the button's own message (`onFailure`), except `NotAllowedError` (the person closed the
//    browser's dialog), which says nothing. A failure that is not the person's own (the options
//    request refused, a page the ceremony cannot run on) would loop, so after QUICK_REARMS
//    straight re-arms in a row the regular timer takes over.

/** Straight re-arms after a failure before the regular timer takes over (no request loop). */
export const QUICK_REARMS = 3;

export type PasskeyAutofillDeps = {
  /** lib/passkey.ts's `signIn` (the lazy chunk). */
  signIn: (mode: 'modal' | 'autofill') => Promise<Me>;
  /** Runs the modal ceremony and settles when it is done, failure included (useAction's `run`). */
  runModal: (ceremony: () => Promise<void>) => Promise<unknown>;
  onSignedIn: (me: Me) => void;
  /** An autofill failure that has a message: the same one the button would show. */
  onFailure: (error: unknown) => void;
  /** lib/passkey.ts's `cancel`: aborts the ceremony in flight and holds back one fetching its options. */
  cancel: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  rearmMs: number;
};

export type PasskeyAutofill = {
  /** Arms the autofill (only where the browser supports it); later calls do nothing. */
  start: () => void;
  /** The button: a modal ceremony, unless one runs or the page is done. */
  modal: () => void;
  /** The screen goes away: no timer, no late result, the ceremony in flight aborted. */
  stop: () => void;
};

export function createPasskeyAutofill(deps: PasskeyAutofillDeps): PasskeyAutofill {
  let started = false;
  let stopped = false;
  let done = false;
  let modalRunning = false;
  let current = 0; // the newest autofill run
  let quick = 0; // straight re-arms in a row
  let timer: { handle: unknown } | null = null;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer.handle);
    timer = null;
  };

  const finish = (me: Me) => {
    // A late result (after stop(), or a second one) is ignored.
    if (stopped || done) return;
    done = true;
    clear();
    deps.onSignedIn(me);
  };

  const arm = (afterFailure: boolean) => {
    clear();
    if (!started || stopped || done || modalRunning) return;
    quick = afterFailure ? quick + 1 : 0;
    const handle = deps.setTimer(() => {
      timer = null;
      arm(false);
    }, deps.rearmMs);
    timer = { handle };
    current += 1;
    const run = current;
    deps.signIn('autofill').then(finish, (error: unknown) => {
      // Aborted on purpose (a modal began, a newer autofill replaced it, the screen went away): silent, never re-armed here.
      if (isCeremonyAborted(error) || stopped || done || modalRunning) return;
      if (!(error instanceof Error && error.name === 'NotAllowedError')) deps.onFailure(error);
      // A newer run is armed already; past the limit, the timer armed with this run re-arms.
      if (run === current && quick < QUICK_REARMS) arm(true);
    });
  };

  return {
    start() {
      if (started) return;
      started = true;
      arm(false);
    },
    modal() {
      if (stopped || done || modalRunning) return;
      modalRunning = true;
      clear();
      const settled = () => {
        modalRunning = false;
        arm(false);
      };
      void deps.runModal(async () => finish(await deps.signIn('modal'))).then(settled, settled);
    },
    stop() {
      stopped = true;
      clear();
      deps.cancel();
    },
  };
}
