import { CodeRequest, type Me } from '@mjk/contracts';
import { type FormEvent, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { Altcha } from './Altcha.tsx';
import { CodeStep } from './CodeStep.tsx';
import { fieldsOf, useAction } from './errors.ts';
import { Field, FormError } from './fields.tsx';

// Sign-in by email code (A§9): the address and an ALTCHA solution, then the 6 digits. `email` is
// given when the member is already known (the "confirm it's you" step): nothing to type then.

export function EmailCodeSignIn({
  locale,
  email: known,
  onSignedIn,
}: {
  locale: Locale;
  email?: string;
  onSignedIn: (me: Me) => void;
}) {
  const [typed, setTyped] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const { busy, failure, setFailure, run } = useAction('plain');

  if (sentTo !== null) {
    return (
      <CodeStep
        locale={locale}
        email={sentTo}
        purpose="signin"
        onVerified={onSignedIn}
        onBack={() => setSentTo(null)}
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CodeRequest.safeParse({
      email: known ?? typed,
      purpose: 'signin',
      altcha: payload ?? '',
      locale,
    });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void run(async () => {
      // Single use: the next try solves a new challenge, whatever this one's answer.
      setPayload(null);
      setRound((n) => n + 1);
      await sendJson('POST', '/api/v1/auth/code', parsed.data);
      setSentTo(parsed.data.email);
    });
  };

  return (
    <form method="post" className="stack" onSubmit={submit} noValidate>
      {known === undefined ? (
        <Field
          label={m.field_email()}
          error={failure?.fields.email}
          name="email"
          type="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      ) : (
        <p>{m.reauth_code_to({ email: known })}</p>
      )}
      <Altcha key={round} locale={locale} onPayload={setPayload} />
      <FormError failure={failure} />
      <button type="submit" className="button" disabled={busy || payload === null}>
        {m.action_send_code()}
      </button>
    </form>
  );
}
