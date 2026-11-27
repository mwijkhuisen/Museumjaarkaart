import type { Me } from '@mjk/contracts';
import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { type Failure, useAction } from './errors.ts';
import { FormError } from './fields.tsx';

// Sign in with a passkey (P2b; A§9). The library is a lazy chunk (lib/passkey.ts): the server
// render and the first client render show nothing, and the section appears only where the browser
// can do WebAuthn.
//
// Two ceremonies share one page:
//  - autofill ("conditional UI"): armed on mount when the browser supports it; it waits behind the
//    `webauthn` input of the two email fields until the person picks a passkey from the browser's
//    list. The server's challenge lives 300 s, so it is armed again with fresh options every 270 s.
//  - the button: a modal ceremony. Starting it aborts the pending autofill through the library's
//    shared abort controller, and that autofill promise rejects with `ERROR_CEREMONY_ABORTED`. An
//    aborted autofill is never re-armed from its rejection (that would abort the modal in turn);
//    the autofill is armed again only after the modal promise has settled.
// Autofill failures are silent. Only the modal ceremony shows a message, a fixed text per failure.
// Nothing reaches the console (the e2e guard fails on any console error).

/** The server's challenge lives 300 s (A§9): arm again with fresh options a little before it ends. */
export const REARM_MS = 270_000;

type Lib = typeof import('../../lib/passkey.ts');

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
  const { busy, failure, run } = useAction('passkey_signin');
  const callback = useRef(onSignedIn);
  callback.current = onSignedIn;
  const modal = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    let live = true;
    let done = false;
    let modalRunning = false;
    let lib: Lib | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (me: Me) => {
      // A late result (after unmount, or a second one) is ignored.
      if (!live || done) return;
      done = true;
      callback.current(me);
    };

    const arm = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!live || done || modalRunning || lib === undefined) return;
      timer = setTimeout(arm, REARM_MS);
      // Silent on every failure, an abort included: the timer (or the end of a modal run) re-arms.
      lib.signIn('autofill').then(finish, () => {});
    };

    modal.current = () => {
      if (!live || done || modalRunning || lib === undefined) return;
      const current = lib;
      modalRunning = true;
      clearTimeout(timer);
      timer = undefined;
      void run(async () => finish(await current.signIn('modal'))).then(() => {
        modalRunning = false;
        arm();
      });
    };

    import('../../lib/passkey.ts')
      .then(async (loaded) => {
        const found = await loaded.support();
        if (!live || !found.webauthn) return;
        lib = loaded;
        setSupported(true);
        if (found.autofill) arm();
      })
      .catch(() => {});

    return () => {
      live = false;
      modal.current = null;
      clearTimeout(timer);
      lib?.cancel();
    };
  }, [run]);

  if (!supported) return null;
  return <PasskeySignInView busy={busy} failure={failure} onClick={() => modal.current?.()} />;
}
