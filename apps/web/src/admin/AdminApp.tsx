import { AdminMe } from '@mjk/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { useAction } from '../components/auth/errors.ts';
import { FormError } from '../components/auth/fields.tsx';
import { SignInMethods } from '../components/auth/SignInMethods.tsx';
import { ApiError, sendJson } from '../lib/api.ts';
import { m } from '../paraglide/messages.js';

// The admin entry's only screen in P2a (A§9, A§15.1): who is signed in, or the sign-in, or "no
// access". The admin screens arrive in P3c. Sign-in here is the code and the password only: no
// sign-up form (accounts are made on the public host).

type State =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'signin' }
  | { kind: 'noaccess' }
  | { kind: 'ok'; me: AdminMe };

const roleText = (role: AdminMe['role']) => (role === 'admin' ? m.role_admin() : m.role_moderator());

export function AdminApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const { busy, failure, run } = useAction('plain');

  useEffect(() => {
    document.title = m.admin_title();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the reload trigger
  useEffect(() => {
    let live = true;
    const set = (next: State) => live && setState(next);
    sendJson('GET', '/api/admin/me', undefined, AdminMe).then(
      (me) => set({ kind: 'ok', me }),
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 401) set({ kind: 'signin' });
        else if (error instanceof ApiError && error.status === 403) set({ kind: 'noaccess' });
        else set({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [round]);

  const reload = () => {
    setState({ kind: 'loading' });
    setRound((n) => n + 1);
  };
  const signOut = () =>
    void run(async () => {
      await sendJson('POST', '/api/v1/auth/signout');
      reload();
    });

  let body: ReactNode;
  switch (state.kind) {
    case 'loading':
      body = <p aria-live="polite">{m.loading()}</p>;
      break;
    case 'failed':
      body = (
        <>
          <p role="alert" className="form-error">
            {m.auth_me_failed()}
          </p>
          <button type="button" className="button" onClick={reload}>
            {m.auth_retry()}
          </button>
        </>
      );
      break;
    case 'signin':
      body = (
        <>
          <p>{m.admin_signin_intro()}</p>
          <SignInMethods locale="nl" onSignedIn={reload} />
        </>
      );
      break;
    case 'noaccess':
    case 'ok':
      body = (
        <>
          <p>
            {state.kind === 'ok'
              ? m.admin_signed_in({ handle: state.me.handle, role: roleText(state.me.role) })
              : m.admin_no_access()}
          </p>
          <FormError failure={failure} />
          <p>
            <button type="button" className="button" disabled={busy} onClick={signOut}>
              {m.action_signout()}
            </button>
          </p>
        </>
      );
      break;
  }
  return (
    <main id="main" className="page stack">
      <h1>{m.admin_title()}</h1>
      {body}
    </main>
  );
}
