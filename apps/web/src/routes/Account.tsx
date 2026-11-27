import { useEffect, useRef, useState } from 'react';
import { PasskeysSection } from '../components/account/PasskeysSection.tsx';
import {
  DisplayNameSection,
  EmailSection,
  type Guard,
  PasswordSection,
  SessionsSection,
  SignOutSection,
} from '../components/account/sections.tsx';
import { ReauthCancelled } from '../components/auth/errors.ts';
import { Reauth } from '../components/auth/Reauth.tsx';
import { Loading } from '../components/layout/Layout.tsx';
import { ApiError } from '../lib/api.ts';
import { useMe } from '../lib/me.ts';
import { useRouter } from '../lib/router.tsx';
import { pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The account page (A§9 "Account settings"; A§15.1: the app shell). Nothing about the member is
// known before the browser has asked `GET /api/v1/me`: the server render is the heading and
// "Loading". A signed-out visitor is sent to the sign-in page (a replace: Back does not come here).

type Pending = { call: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };

export function Account({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  const { locale } = route;
  const { navigate } = useRouter();
  const { me, failed, setMe, reload } = useMe();
  const pending = useRef<Pending | null>(null);
  const [asking, setAsking] = useState(false);
  // Removing a passkey signs out the other sessions: a new key remounts the list, which fetches again.
  const [sessionsKey, setSessionsKey] = useState(0);

  const signedOut = me !== undefined && me.user === null;
  useEffect(() => {
    if (signedOut) navigate(pathOf({ page: 'shell', locale, app: 'signin' }), { replace: true });
  }, [signedOut, navigate, locale]);

  // On 403 `reauth_required`: park the call, ask the member to confirm, then run it once more. The
  // caller's promise settles with that second run, or with a cancel.
  const guard: Guard = (call) =>
    call().catch((error: unknown) => {
      if (!(error instanceof ApiError) || error.code !== 'reauth_required') throw error;
      pending.current?.reject(new ReauthCancelled());
      return new Promise<void>((resolve, reject) => {
        pending.current = { call, resolve, reject };
        setAsking(true);
      });
    });
  const settle = (retry: boolean) => {
    const p = pending.current;
    pending.current = null;
    setAsking(false);
    if (p === undefined || p === null) return;
    if (retry) p.call().then(p.resolve, p.reject);
    else p.reject(new ReauthCancelled());
  };

  if (failed) {
    return (
      <div className="stack">
        <h1>{m.page_account()}</h1>
        <p role="alert" className="form-error">
          {m.auth_me_failed()}
        </p>
        <button type="button" className="button" onClick={reload}>
          {m.auth_retry()}
        </button>
      </div>
    );
  }
  if (me === undefined || me.user === null) {
    return (
      <div className="stack">
        <h1>{m.page_account()}</h1>
        <Loading />
      </div>
    );
  }
  const user = me.user;
  return (
    <div className="stack">
      <h1>{m.page_account()}</h1>
      <p>{m.account_signed_in_as({ name: user.display_name, handle: user.handle })}</p>
      {asking ? (
        <Reauth
          locale={locale}
          email={user.email}
          hasPassword={user.has_password}
          onDone={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
      <DisplayNameSection user={user} onChanged={setMe} />
      <EmailSection user={user} locale={locale} guard={guard} onChanged={setMe} />
      <PasswordSection user={user} guard={guard} onChanged={reload} />
      <PasskeysSection locale={locale} guard={guard} onSessionsEnded={() => setSessionsKey((n) => n + 1)} />
      <SessionsSection key={sessionsKey} locale={locale} guard={guard} />
      <SignOutSection guard={guard} onSignedOut={() => navigate(pathOf({ page: 'home', locale }))} />
    </div>
  );
}
