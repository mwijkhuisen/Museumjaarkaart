import type { Me } from '@mjk/contracts';
import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { describeError, type Failure, useAction } from './errors.ts';
import { FormError } from './fields.tsx';
import { createPasskeyAutofill, type PasskeyAutofill } from './passkey-autofill.ts';

// Sign in with a passkey (P2b; A§9). The library is a lazy chunk (lib/passkey.ts): the server
// render and the first client render show nothing, and the section appears only where the browser
// can do WebAuthn. The autofill and the button's ceremony are a state machine of their own
// (passkey-autofill.ts); this component only wires it to the page. Every failure the person should
// know about shows a fixed text per failure, and nothing reaches the console (the e2e guard fails
// on any console error).

/** The server's challenge lives 300 s (A§9): arm again with fresh options a little before it ends. */
export const REARM_MS = 270_000;

export function PasskeySignInView({
  busy,
  failure,
  onClick,
}: {
  busy: boolean;
  failure: Failure | null;
  onClick: () => void;
}) {
  return (
    <section className="stack" aria-labelledby="signin-passkey">
      <h2 id="signin-passkey">{m.auth_passkey_heading()}</h2>
      <p>{m.auth_passkey_intro()}</p>
      <FormError failure={failure} />
      <div>
        <button type="button" className="button" disabled={busy} onClick={onClick}>
          {m.action_signin_passkey()}
        </button>
      </div>
    </section>
  );
}

export function PasskeySignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [supported, setSupported] = useState(false);
  const { busy, failure, setFailure, run } = useAction('passkey_signin');
  const callback = useRef(onSignedIn);
  callback.current = onSignedIn;
  const control = useRef<PasskeyAutofill | null>(null);

  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    let live = true;
    let ctl: PasskeyAutofill | undefined;

    import('../../lib/passkey.ts')
      .then(async (lib) => {
        const found = await lib.support();
        if (!live || !found.webauthn) return;
        ctl = createPasskeyAutofill({
          signIn: lib.signIn,
          runModal: run,
          onSignedIn: (me) => callback.current(me),
          onFailure: (error) => setFailure(describeError(error, 'passkey_signin')),
          cancel: lib.cancel,
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          rearmMs: REARM_MS,
        });
        control.current = ctl;
        setSupported(true);
        if (found.autofill) ctl.start();
      })
      .catch(() => {});

    return () => {
      live = false;
      control.current = null;
      ctl?.stop();
    };
  }, [run, setFailure]);

  if (!supported) return null;
  return <PasskeySignInView busy={busy} failure={failure} onClick={() => control.current?.modal()} />;
}
