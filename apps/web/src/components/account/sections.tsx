import {
  EmailChangeRequest,
  EmailVerifyRequest,
  Me,
  MePatchRequest,
  type MeUser,
  PasswordSetRequest,
  type SessionItem,
  SessionList,
} from '@mjk/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, getJson, sendJson } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { fieldsOf, useAction } from '../auth/errors.ts';
import { Field, FormError } from '../auth/fields.tsx';

// The sections of the account page (A§9 "Account settings"). A change that needs a recent sign-in
// answers 403 `reauth_required`: each such call runs through `guard`, which shows the
// "confirm it's you" step and runs the call once more when it is done.

/** Runs `call`; on 403 `reauth_required` waits for the member to confirm, then runs it once more. */
export type Guard = (call: () => Promise<void>) => Promise<void>;

type Props = { user: MeUser; locale: Locale; guard: Guard };

export function DisplayNameSection({ user, onChanged }: { user: MeUser; onChanged: (me: Me) => void }) {
  const [name, setName] = useState(user.display_name);
  const [saved, setSaved] = useState(false);
  const { busy, failure, setFailure, run } = useAction('plain');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = MePatchRequest.safeParse({ display_name: name });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    setSaved(false);
    void run(async () => {
      onChanged(await sendJson('PATCH', '/api/v1/me', parsed.data, Me));
      setSaved(true);
    });
  };
  return (
    <section className="stack" aria-labelledby="account-name">
      <h2 id="account-name">{m.account_h_name()}</h2>
      <form method="post" className="stack" onSubmit={submit} noValidate>
        <Field
          label={m.field_display_name()}
          hint={m.field_hint_display_name()}
          error={failure?.fields.display_name}
          name="display_name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          autoComplete="nickname"
          maxLength={50}
          required
        />
        <FormError failure={failure} />
        <p role="status" className="notice">
          {saved ? m.account_name_saved() : ''}
        </p>
        <button type="submit" className="button" disabled={busy}>
          {m.action_save()}
        </button>
      </form>
    </section>
  );
}

export function EmailSection({ user, locale, guard, onChanged }: Props & { onChanged: (me: Me) => void }) {
  const [target, setTarget] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const { busy, failure, setFailure, run } = useAction('email');

  const request = (event: FormEvent) => {
    event.preventDefault();
    const parsed = EmailChangeRequest.safeParse({ email, locale });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    setDone(false);
    void run(() =>
      guard(async () => {
        await sendJson('POST', '/api/v1/me/email', parsed.data);
        setTarget(parsed.data.email);
      }),
    );
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    const parsed = EmailVerifyRequest.safeParse({ code });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void run(async () => {
      onChanged(await sendJson('POST', '/api/v1/me/email/verify', parsed.data, Me));
      setTarget(null);
      setEmail('');
      setCode('');
      setDone(true);
    });
  };

  return (
    <section className="stack" aria-labelledby="account-email">
      <h2 id="account-email">{m.account_h_email()}</h2>
      <p>{m.account_email_current({ email: user.email })}</p>
      {target === null ? (
        <form method="post" className="stack" onSubmit={request} noValidate>
          <Field
            label={m.field_new_email()}
            error={failure?.fields.email}
            name="new_email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <FormError failure={failure} />
          <p role="status" className="notice">
            {done ? m.account_email_changed() : ''}
          </p>
          <button type="submit" className="button" disabled={busy}>
            {m.action_send_code()}
          </button>
        </form>
      ) : (
        <form method="post" className="stack" onSubmit={verify} noValidate>
          <p role="status">{m.account_email_code_sent({ email: target })}</p>
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
          <FormError failure={failure} />
          <div className="cluster">
            <button type="submit" className="button" disabled={busy}>
              {m.action_verify()}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setTarget(null);
                setFailure(null);
              }}
            >
              {m.action_back()}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function PasswordSection({ user, guard, onChanged }: Omit<Props, 'locale'> & { onChanged: () => void }) {
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const { busy, failure, setFailure, run } = useAction('plain');

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = PasswordSetRequest.safeParse({ password });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    setNotice('');
    void run(() =>
      guard(async () => {
        await sendJson('PUT', '/api/v1/me/password', parsed.data);
        setPassword('');
        setNotice(m.account_password_saved());
        onChanged();
      }),
    );
  };

  const remove = () => {
    setNotice('');
    void run(() =>
      guard(async () => {
        await sendJson('DELETE', '/api/v1/me/password');
        setNotice(m.account_password_removed());
        onChanged();
      }),
    );
  };

  return (
    <section className="stack" aria-labelledby="account-password">
      <h2 id="account-password">{m.account_h_password()}</h2>
      <p>{user.has_password ? m.account_password_has() : m.account_password_none()}</p>
      <p className="muted">{m.auth_lost_mailbox()}</p>
      <form method="post" className="stack" onSubmit={save} noValidate>
        <Field
          label={m.field_new_password()}
          hint={m.field_hint_password()}
          error={failure?.fields.password}
          name="new_password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <FormError failure={failure} />
        <p role="status" className="notice">
          {notice}
        </p>
        <div className="cluster">
          <button type="submit" className="button" disabled={busy}>
            {user.has_password ? m.action_change_password() : m.action_set_password()}
          </button>
          {user.has_password ? (
            <button type="button" className="button button--quiet" disabled={busy} onClick={remove}>
              {m.action_remove_password()}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

const methodText = (method: SessionItem['method']) => {
  switch (method) {
    case 'code':
      return m.session_method_code();
    case 'password':
      return m.session_method_password();
    case 'passkey':
      return m.session_method_passkey();
  }
};
const hostText = (host: SessionItem['host']) => (host === 'admin' ? m.session_host_admin() : m.session_host_public());

export function SessionsSection({ locale, guard }: Pick<Props, 'locale' | 'guard'>) {
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const { busy, failure, run } = useAction('plain');

  const load = useCallback(async () => {
    try {
      setItems((await getJson('/api/v1/me/sessions', SessionList)).items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const end = (ref: string) => {
    setNotice('');
    void run(() =>
      guard(async () => {
        try {
          await sendJson('DELETE', `/api/v1/me/sessions/${ref}`);
        } catch (error) {
          // Already gone (ended elsewhere meanwhile): the list below is the truth.
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        setNotice(m.account_session_ended());
        await load();
      }),
    );
  };

  return (
    <section className="stack" aria-labelledby="account-sessions">
      <h2 id="account-sessions">{m.account_h_sessions()}</h2>
      <p>{m.account_sessions_intro()}</p>
      {failed ? <p className="form-error">{m.auth_err_generic()}</p> : null}
      {items === null ? (
        failed ? null : (
          <p aria-live="polite">{m.loading()}</p>
        )
      ) : (
        <ul className="session-list">
          {items.map((s) => (
            <li key={s.ref} className="card">
              <p>
                <strong>{methodText(s.method)}</strong> · {hostText(s.host)}
                {s.current ? (
                  <>
                    {' '}
                    <span className="badge badge--current">{m.account_session_current()}</span>
                  </>
                ) : null}
              </p>
              <p className="muted">
                {m.account_session_created({ date: formatDateTime(s.created_at, locale) })}
                {' · '}
                {m.account_session_last_used({ date: formatDateTime(s.last_used_at, locale) })}
              </p>
              {s.current ? null : (
                <button type="button" className="button button--quiet" disabled={busy} onClick={() => end(s.ref)}>
                  {m.action_end_session()}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError failure={failure} />
      <p role="status" className="notice">
        {notice}
      </p>
    </section>
  );
}

export function SignOutSection({ guard, onSignedOut }: { guard: Guard; onSignedOut: () => void }) {
  const { busy, failure, run } = useAction('plain');
  const out = (path: string, guarded: boolean) =>
    void run(async () => {
      const call = () => sendJson('POST', path);
      await (guarded ? guard(call) : call());
      onSignedOut();
    });
  return (
    <section className="stack" aria-labelledby="account-signout">
      <h2 id="account-signout">{m.account_h_signout()}</h2>
      <p>{m.account_signout_all_help()}</p>
      <FormError failure={failure} />
      <div className="cluster">
        <button type="button" className="button" disabled={busy} onClick={() => out('/api/v1/auth/signout', false)}>
          {m.action_signout()}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => out('/api/v1/auth/signout-all', true)}
        >
          {m.action_signout_all()}
        </button>
      </div>
    </section>
  );
}
