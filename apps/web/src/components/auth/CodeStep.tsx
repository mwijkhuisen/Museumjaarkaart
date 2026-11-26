import { CodeVerifyRequest, Me } from '@mjk/contracts';
import { type FormEvent, useState } from 'react';
import { ApiError, sendJson } from '../../lib/api.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { Altcha } from './Altcha.tsx';
import { fieldsOf, useAction } from './errors.ts';
import { Field, FormError } from './fields.tsx';

// The second step of a code sign-in, a sign-up or a "confirm it's you": the 6 digits from the mail
// (A§9: valid 10 minutes, 5 attempts, single use). Past the site-wide failure threshold the server
// answers 400 with `fields: ["altcha"]`; the widget then appears and its solution goes with the
// next try.

export function CodeStep({
  locale,
  email,
  purpose,
  onVerified,
  onBack,
}: {
  locale: Locale;
  email: string;
  purpose: 'signin' | 'signup';
  onVerified: (me: Me) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [payload, setPayload] = useState<string | null>(null);
  const [altcha, setAltcha] = useState(false);
  const [round, setRound] = useState(0);
  const { busy, failure, setFailure, run } = useAction('verify');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CodeVerifyRequest.safeParse({
      email,
      purpose,
      code,
      ...(altcha && payload !== null ? { altcha: payload } : {}),
    });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void run(async () => {
      try {
        onVerified(await sendJson('POST', '/api/v1/auth/code/verify', parsed.data, Me));
      } catch (error) {
        // An ALTCHA solution is single use: a new challenge for every try.
        if (altcha) {
          setPayload(null);
          setRound((n) => n + 1);
        }
        if (error instanceof ApiError && error.code === 'bad_request' && error.fields.includes('altcha')) {
          setAltcha(true);
          setFailure({ text: m.auth_err_field_altcha(), fields: {} });
          return;
        }
        throw error;
      }
    });
  };

  return (
    <form method="post" className="stack" onSubmit={submit} noValidate>
      <p role="status">{m.auth_code_sent({ email })}</p>
      <Field
        label={m.field_code()}
        hint={m.field_hint_code()}
        error={failure?.fields.code}
        className="code-input"
        name="code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        required
      />
      {altcha ? <Altcha key={round} locale={locale} onPayload={setPayload} /> : null}
      <FormError failure={failure} />
      <div className="cluster">
        <button type="submit" className="button" disabled={busy || (altcha && payload === null)}>
          {m.action_verify()}
        </button>
        <button type="button" className="button button--quiet" onClick={onBack}>
          {m.action_back()}
        </button>
      </div>
    </form>
  );
}
