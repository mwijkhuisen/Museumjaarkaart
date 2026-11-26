import type { Me } from '@mjk/contracts';
import { type ReactNode, useEffect, useState } from 'react';
import { SignInMethods } from '../components/auth/SignInMethods.tsx';
import { SignUpForm } from '../components/auth/SignUpForm.tsx';
import { Loading } from '../components/layout/Layout.tsx';
import { useMe } from '../lib/me.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The sign-in page (A§9, A§15.1: the app shell). The server sends the heading and "Loading" only;
// the member is not known before the browser asks `GET /api/v1/me`, so the first client render is
// the same markup and the forms appear after that. An invite arrives in the URL fragment
// (`#uitnodiging=<code>` or `#invite=<code>`), which never reaches a server or a log (A§15.2): read
// once after mounting, then removed from the address bar.

const INVITE_PREFIXES = ['uitnodiging=', 'invite='];
const INVITE_MAX = 64;

function inviteFromHash(): string | null {
  const hash = location.hash.slice(1);
  const prefix = INVITE_PREFIXES.find((p) => hash.startsWith(p));
  if (prefix === undefined) return null;
  const raw = hash.slice(prefix.length);
  try {
    return decodeURIComponent(raw).slice(0, INVITE_MAX);
  } catch {
    return raw.slice(0, INVITE_MAX);
  }
}

export function SignIn({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  const { locale } = route;
  const { navigate } = useRouter();
  const { me, failed, setMe, reload } = useMe();
  const [signUp, setSignUp] = useState(false);
  const [invite, setInvite] = useState('');

  useEffect(() => {
    const code = inviteFromHash();
    if (code === null) return;
    setInvite(code);
    setSignUp(true);
    history.replaceState(null, '', location.pathname + location.search);
  }, []);

  const account = pathOf({ page: 'shell', locale, app: 'account' });
  const signedIn = (value: Me) => {
    setMe(value);
    navigate(account);
  };

  let body: ReactNode;
  if (failed) {
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
  } else if (me === undefined) {
    body = <Loading />;
  } else if (me.user !== null) {
    body = (
      <>
        <p>{m.auth_signed_in()}</p>
        <p>
          <Link className="button" href={account}>
            {m.auth_to_account()}
          </Link>
        </p>
      </>
    );
  } else if (signUp) {
    body = (
      <section className="stack" aria-labelledby="signup-heading">
        <h2 id="signup-heading">{m.auth_signup_heading()}</h2>
        <p>{m.auth_signup_intro()}</p>
        <SignUpForm locale={locale} initialInvite={invite} onSignedIn={signedIn} />
        <p>
          <button type="button" className="link-button" onClick={() => setSignUp(false)}>
            {m.auth_have_account()}
          </button>
        </p>
      </section>
    );
  } else {
    body = (
      <>
        <SignInMethods locale={locale} onSignedIn={signedIn} />
        <p>
          <button type="button" className="link-button" onClick={() => setSignUp(true)}>
            {m.auth_invite_toggle()}
          </button>
        </p>
      </>
    );
  }

  return (
    <div className="stack">
      <h1>{m.page_signin()}</h1>
      {body}
    </div>
  );
}
