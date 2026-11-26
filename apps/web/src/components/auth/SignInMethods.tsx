import type { Me } from '@mjk/contracts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { EmailCodeSignIn } from './EmailCodeSignIn.tsx';
import { PasswordSignIn } from './PasswordSignIn.tsx';

// The two ways in (A§9), one under the other, shared by the public sign-in page and the admin
// entry (which never offers the sign-up form). The help text names the lost-mailbox position.

export function SignInMethods({ locale, onSignedIn }: { locale: Locale; onSignedIn: (me: Me) => void }) {
  return (
    <>
      <section className="stack" aria-labelledby="signin-code">
        <h2 id="signin-code">{m.auth_code_heading()}</h2>
        <p>{m.auth_code_intro()}</p>
        <EmailCodeSignIn locale={locale} onSignedIn={onSignedIn} />
      </section>
      <section className="stack" aria-labelledby="signin-password">
        <h2 id="signin-password">{m.auth_password_heading()}</h2>
        <PasswordSignIn onSignedIn={onSignedIn} />
      </section>
      <p className="muted">{m.auth_lost_mailbox()}</p>
    </>
  );
}
