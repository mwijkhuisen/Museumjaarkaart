import { Me, PasswordSignInRequest } from '@mjk/contracts';
import { type FormEvent, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { m } from '../../paraglide/messages.js';
import { fieldsOf, useAction } from './errors.ts';
import { Field, FormError } from './fields.tsx';

// Sign-in by password (A§9). `email` is given when the member is already known (reauthentication).

export function PasswordSignIn({ email: known, onSignedIn }: { email?: string; onSignedIn: (me: Me) => void }) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const { busy, failure, setFailure, run } = useAction('password');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = PasswordSignInRequest.safeParse({ email: known ?? typed, password });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void run(async () => {
      onSignedIn(await sendJson('POST', '/api/v1/auth/password', parsed.data, Me));
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
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      ) : null}
      <Field
        label={m.field_password()}
        error={failure?.fields.password}
        name="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
      />
      <FormError failure={failure} />
      <button type="submit" className="button" disabled={busy}>
        {m.action_signin()}
      </button>
    </form>
  );
}
