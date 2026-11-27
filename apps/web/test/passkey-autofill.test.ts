import type { Me } from '@mjk/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPasskeyAutofill, QUICK_REARMS } from '../src/components/auth/passkey-autofill.ts';

// The sign-in page's passkey state machine (P2b review): the autofill, the button's modal ceremony,
// the re-arm timer and the abort rules, driven by fake `signIn` promises and fake timers.

const REARM = 270_000;
const ME: Me = { user: null };
const OTHER: Me = { user: null };

type Pending = {
  mode: 'modal' | 'autofill';
  resolve: (me: Me) => void;
  reject: (error: unknown) => void;
};

const abortError = () =>
  Object.assign(new Error('Authentication ceremony was sent an abort signal'), {
    name: 'AbortError',
    code: 'ERROR_CEREMONY_ABORTED',
  });
const named = (name: string) => Object.assign(new Error(name), { name });

function setup() {
  const calls: Pending[] = [];
  const signIn = vi.fn(
    (mode: 'modal' | 'autofill') =>
      new Promise<Me>((resolve, reject) => {
        calls.push({ mode, resolve, reject });
      }),
  );
  const onSignedIn = vi.fn();
  const onFailure = vi.fn();
  const cancel = vi.fn();
  const modalFailures: unknown[] = [];
  // useAction's `run`: settles after the ceremony, a failure included.
  const runModal = vi.fn(async (ceremony: () => Promise<void>) => {
    try {
      await ceremony();
    } catch (error) {
      modalFailures.push(error);
    }
  });
  const ctl = createPasskeyAutofill({
    signIn,
    runModal,
    onSignedIn,
    onFailure,
    cancel,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rearmMs: REARM,
  });
  const autofills = () => calls.filter((c) => c.mode === 'autofill');
  const modals = () => calls.filter((c) => c.mode === 'modal');
  const last = (list: Pending[]) => {
    const item = list.at(-1);
    if (item === undefined) throw new Error('no call');
    return item;
  };
  return { ctl, signIn, onSignedIn, onFailure, cancel, modalFailures, autofills, modals, last };
}

/** Lets every settled promise run its handlers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPasskeyAutofill', () => {
  it('arms the autofill once on start and again with fresh options every 270 s', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.start();
    expect(t.autofills()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REARM - 1);
    expect(t.autofills()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.autofills()).toHaveLength(2);
    // The replaced run is aborted by the new one's ceremony: silent, no extra run.
    t.autofills()[0]?.reject(abortError());
    await flush();
    expect(t.autofills()).toHaveLength(2);
    expect(t.onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REARM);
    expect(t.autofills()).toHaveLength(3);
  });

  it('never re-arms an aborted autofill by itself', async () => {
    const t = setup();
    t.ctl.start();
    t.last(t.autofills()).reject(abortError());
    await flush();
    expect(t.autofills()).toHaveLength(1);
    // A bare AbortError (lib/passkey.ts's own, or the platform's) is the same.
    await vi.advanceTimersByTimeAsync(REARM);
    expect(t.autofills()).toHaveLength(2);
    t.last(t.autofills()).reject(named('AbortError'));
    await flush();
    expect(t.autofills()).toHaveLength(2);
    expect(t.onFailure).not.toHaveBeenCalled();
  });

  it('a modal run aborts the pending autofill and re-arms it only after the modal settles', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.modal();
    expect(t.modals()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // The modal's ceremony aborted the autofill: no re-arm while the modal runs, the timer is gone.
    t.last(t.autofills()).reject(abortError());
    await flush();
    await vi.advanceTimersByTimeAsync(REARM * 2);
    expect(t.autofills()).toHaveLength(1);
    // A second click while the modal runs starts nothing.
    t.ctl.modal();
    expect(t.modals()).toHaveLength(1);
    // The modal fails (the person cancelled it): its message is the modal's, and the autofill is armed again.
    t.last(t.modals()).reject(named('NotAllowedError'));
    await flush();
    expect(t.modalFailures).toHaveLength(1);
    expect(t.onFailure).not.toHaveBeenCalled();
    expect(t.autofills()).toHaveLength(2);
    expect(t.onSignedIn).not.toHaveBeenCalled();
  });

  it('a failure of a pending autofill while the modal runs neither shows nor re-arms', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.modal();
    t.last(t.autofills()).reject(Object.assign(new Error('unauthorized'), { name: 'ApiError' }));
    await flush();
    expect(t.onFailure).not.toHaveBeenCalled();
    expect(t.autofills()).toHaveLength(1);
  });

  it('calls onSignedIn once and ignores a second, late success', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.modal();
    t.last(t.autofills()).resolve(ME); // the autofill had already got past its ceremony
    await flush();
    expect(t.onSignedIn).toHaveBeenCalledTimes(1);
    expect(t.onSignedIn).toHaveBeenCalledWith(ME);
    t.last(t.modals()).resolve(OTHER);
    await flush();
    expect(t.onSignedIn).toHaveBeenCalledTimes(1);
    // Done: no timer, no button, no re-arm.
    await vi.advanceTimersByTimeAsync(REARM * 2);
    t.ctl.modal();
    expect(t.autofills()).toHaveLength(1);
    expect(t.modals()).toHaveLength(1);
  });

  it('stop() cancels the ceremony and the timer and ignores a late result', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.stop();
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REARM * 2);
    expect(t.autofills()).toHaveLength(1);
    t.last(t.autofills()).resolve(ME);
    await flush();
    expect(t.onSignedIn).not.toHaveBeenCalled();
    t.ctl.modal();
    expect(t.modals()).toHaveLength(0);
  });

  it('stop() ignores a late failure too: no message, no re-arm', async () => {
    const t = setup();
    t.ctl.start();
    t.ctl.stop();
    t.last(t.autofills()).reject(named('UnknownError'));
    await flush();
    expect(t.onFailure).not.toHaveBeenCalled();
    expect(t.autofills()).toHaveLength(1);
  });

  it('a failure that is not an abort shows its message and re-arms straight away', async () => {
    const t = setup();
    t.ctl.start();
    const refused = Object.assign(new Error('unauthorized'), { name: 'ApiError' });
    t.last(t.autofills()).reject(refused);
    await flush();
    expect(t.onFailure).toHaveBeenCalledExactlyOnceWith(refused);
    expect(t.autofills()).toHaveLength(2);
    // The re-armed run then signs in.
    t.last(t.autofills()).resolve(ME);
    await flush();
    expect(t.onSignedIn).toHaveBeenCalledExactlyOnceWith(ME);
  });

  it('NotAllowedError (the person closed the dialog) re-arms straight away without a message', async () => {
    const t = setup();
    t.ctl.start();
    t.last(t.autofills()).reject(named('NotAllowedError'));
    await flush();
    expect(t.onFailure).not.toHaveBeenCalled();
    expect(t.autofills()).toHaveLength(2);
  });

  it(`stops re-arming straight away after ${QUICK_REARMS} failures in a row and leaves it to the timer`, async () => {
    const t = setup();
    t.ctl.start();
    for (let i = 0; i <= QUICK_REARMS; i += 1) {
      t.last(t.autofills()).reject(new TypeError('Failed to fetch'));
      await flush();
    }
    expect(t.autofills()).toHaveLength(QUICK_REARMS + 1);
    expect(t.onFailure).toHaveBeenCalledTimes(QUICK_REARMS + 1);
    await vi.advanceTimersByTimeAsync(REARM);
    expect(t.autofills()).toHaveLength(QUICK_REARMS + 2);
    // The timer's run starts a new streak.
    t.last(t.autofills()).reject(new TypeError('Failed to fetch'));
    await flush();
    expect(t.autofills()).toHaveLength(QUICK_REARMS + 3);
  });

  it('a failure of a replaced run shows its message but arms nothing more', async () => {
    const t = setup();
    t.ctl.start();
    await vi.advanceTimersByTimeAsync(REARM);
    expect(t.autofills()).toHaveLength(2);
    t.autofills()[0]?.reject(Object.assign(new Error('unauthorized'), { name: 'ApiError' }));
    await flush();
    expect(t.onFailure).toHaveBeenCalledTimes(1);
    expect(t.autofills()).toHaveLength(2);
  });

  it('start() while a modal runs arms the autofill only once the modal has settled', async () => {
    const t = setup();
    t.ctl.modal();
    t.ctl.start();
    expect(t.autofills()).toHaveLength(0);
    t.last(t.modals()).reject(named('NotAllowedError'));
    await flush();
    expect(t.autofills()).toHaveLength(1);
  });

  it('without start() (no autofill support) the button works and the end of a modal arms nothing', async () => {
    const t = setup();
    t.ctl.modal();
    t.last(t.modals()).reject(named('NotAllowedError'));
    await flush();
    expect(t.autofills()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(REARM);
    expect(t.autofills()).toHaveLength(0);
  });
});
