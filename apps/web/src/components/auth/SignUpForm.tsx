import { type Me, SignupRequest, TERMS_VERSION } from '@mjk/contracts';
import { type FormEvent, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { Altcha } from './Altcha.tsx';
import { CodeStep } from './CodeStep.tsx';
import { fieldsOf, useAction } from './errors.ts';
import { CheckField, Field, FormError } from './fields.tsx';

// Sign-up by invite (A§9): the invite, the address, a handle, a display name, the 16+ box, the
// current terms, an ALTCHA solution and a honeypot (field `mjk_hp_field`, sent as `website`; hidden
// off-screen, never filled by a person, and named so that autofill leaves it alone). The server answers 202 whatever the address; the account exists once the code is entered.
// The terms and the privacy notice open in a new tab, so a half-filled form survives the reading.

export function SignUpForm({
  locale,
  initialInvite,
  onSignedIn,
}: {
  locale: Locale;
  initialInvite: string;
  onSignedIn: (me: Me) => void;
}) {
  const [invite, setInvite] = useState(initialInvite);
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [website, setWebsite] = useState('');
  const [payload, setPayload] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { busy, failure, setFailure, run } = useAction('signup');

  if (sentTo !== null) {
    return (
      <CodeStep
        locale={locale}
        email={sentTo}
        purpose="signup"
        onVerified={onSignedIn}
        onBack={() => setSentTo(null)}
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = SignupRequest.safeParse({
      invite,
      email,
      handle,
      display_name: displayName,
      age_confirmed: age,
      terms_version: TERMS_VERSION,
      altcha: payload ?? '',
      locale,
      website,
    });
    // The two boxes are ticked by a person: an unticked one is a field error here, before the server's 422.
    const fields = parsed.success ? {} : fieldsOf(parsed.error);
    const unticked = {
      ...(age ? {} : { age_confirmed: m.auth_err_field_age() }),
      ...(terms ? {} : { terms_version: m.auth_err_field_terms() }),
    };
    if (!parsed.success || !age || !terms) {
      setFailure({ text: m.auth_err_bad_request(), fields: { ...fields, ...unticked } });
      return;
    }
    void run(async () => {
      // Single use: the next try solves a new challenge, whatever this one's answer.
      setPayload(null);
      setRound((n) => n + 1);
      await sendJson('POST', '/api/v1/auth/signup', parsed.data);
      setSentTo(parsed.data.email);
    });
  };

  const fieldError = (name: string) => failure?.fields[name];
  return (
    <form method="post" className="stack" onSubmit={submit} noValidate>
      <Field
        label={m.field_invite()}
        hint={m.field_hint_invite()}
        error={fieldError('invite')}
        name="invite"
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
      />
      <Field
        label={m.field_email()}
        error={fieldError('email')}
        name="email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
      />
      <Field
        label={m.field_handle()}
        hint={m.field_hint_handle()}
        error={fieldError('handle')}
        name="handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value.toLowerCase())}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={30}
        required
      />
      <Field
        label={m.field_display_name()}
        hint={m.field_hint_display_name()}
        error={fieldError('display_name')}
        name="display_name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        autoComplete="nickname"
        maxLength={50}
        required
      />
      <CheckField
        label={m.auth_age()}
        error={fieldError('age_confirmed')}
        name="age_confirmed"
        checked={age}
        onChange={(e) => setAge(e.target.checked)}
      />
      <CheckField
        label={
          <>
            {m.auth_terms_agree()}{' '}
            <a href={pathOf({ page: 'legal', locale, doc: 'terms' })} target="_blank" rel="noopener">
              {m.auth_terms_link()}
            </a>
          </>
        }
        error={fieldError('terms_version')}
        name="terms"
        checked={terms}
        onChange={(e) => setTerms(e.target.checked)}
      />
      <p>
        {m.auth_privacy_lead()}{' '}
        <a href={pathOf({ page: 'legal', locale, doc: 'privacy' })} target="_blank" rel="noopener">
          {m.auth_privacy_link()}
        </a>
        .
      </p>
      {/* The honeypot: off-screen (a class, never a style attribute), hidden from assistive technology
          and from the tab order. A person never fills it; a script that fills every field does. */}
      <div className="hp" aria-hidden="true">
        <Field
          label={m.field_website()}
          name="mjk_hp_field"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      <Altcha key={round} locale={locale} onPayload={setPayload} />
      {fieldError('altcha') === undefined ? null : <p className="field__error">{fieldError('altcha')}</p>}
      <FormError failure={failure} />
      <button type="submit" className="button" disabled={busy || payload === null}>
        {m.action_signup()}
      </button>
    </form>
  );
}
