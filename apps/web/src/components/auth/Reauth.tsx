import { useEffect, useRef } from 'react';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { EmailCodeSignIn } from './EmailCodeSignIn.tsx';
import { PasskeyReauth } from './PasskeyReauth.tsx';
import { PasswordSignIn } from './PasswordSignIn.tsx';

// "Confirm it's you" (A§9): a sensitive change answered 403 `reauth_required`, so the member signs
// in again, here and now, with one of their own passkeys (when they have one and the browser can),
// a code to their own address or (when set) their password. Each sets a fresh session cookie, and
// the caller retries the action once. The passkey part is client only and never offers the
// `webauthn` autofill token.

export function Reauth({
  locale,
  email,
  hasPassword,
  onDone,
  onCancel,
}: {
  locale: Locale;
  email: string;
  hasPassword: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  // It appears where the action was started, possibly far from the top: bring it into view.
  useEffect(() => section.current?.focus(), []);
  return (
    <section ref={section} tabIndex={-1} className="card stack reauth" aria-labelledby="reauth-heading">
      <h2 id="reauth-heading">{m.reauth_heading()}</h2>
      <p>{m.reauth_intro()}</p>
      <PasskeyReauth onDone={onDone} />
      <EmailCodeSignIn locale={locale} email={email} onSignedIn={onDone} />
      {hasPassword ? (
        <>
          <p>{m.reauth_or_password()}</p>
          <PasswordSignIn email={email} onSignedIn={onDone} />
        </>
      ) : null}
      <button type="button" className="button button--quiet" onClick={onCancel}>
        {m.action_cancel()}
      </button>
    </section>
  );
}
