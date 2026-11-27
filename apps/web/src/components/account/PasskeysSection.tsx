import { PASSKEY_MAX, PasskeyItem, PasskeyList, PasskeyName, PasskeyRenameRequest } from '@mjk/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getJson, sendJson } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { fieldsOf, useAction } from '../auth/errors.ts';
import { Field, FormError } from '../auth/fields.tsx';
import type { Guard } from './sections.tsx';

// The account's passkeys (P2b; A§9). Hidden where the browser has no WebAuthn. The library is a lazy
// chunk (lib/passkey.ts), loaded by the support check and by "Add a passkey". Starting an add needs
// a sign-in within the last 5 minutes and finishing it one within the last 10; removing needs one
// within the last 10. Both run through `guard`, which shows "confirm it's you" on 403
// `reauth_required` and runs the whole call once more (fresh options included). Removing one also
// signs out every other session, so it asks first ("Remove …? Yes / No"), and the sessions list is
// reloaded afterwards.

type Props = { locale: Locale; guard: Guard; onSessionsEnded: () => void };

export function PasskeysSection({ locale, guard, onSessionsEnded }: Props) {
  const [supported, setSupported] = useState(false);
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const adding = useAction('passkey_add');
  const managing = useAction('passkey_manage');

  useEffect(() => {
    // Effects never run on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    let live = true;
    import('../../lib/passkey.ts')
      .then((lib) => lib.support())
      .then(
        (found) => live && setSupported(found.webauthn),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      setItems((await getJson('/api/v1/me/passkeys', PasskeyList)).items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);
  // The question replaces the "Remove" button that had the focus: "No" takes it.
  useEffect(() => {
    if (confirming !== null) keep.current?.focus();
  }, [confirming]);

  if (!supported) return null;

  const add = (event: FormEvent) => {
    event.preventDefault();
    // A handler never runs on the server; the constant lets the SSR build drop the chunk too.
    if (import.meta.env.SSR) return;
    const typed = name.trim();
    if (typed !== '' && !PasskeyName.safeParse(typed).success) {
      adding.setFailure({ text: m.auth_err_bad_request(), fields: { name: m.auth_err_field_passkey_name() } });
      return;
    }
    setNotice('');
    void adding.run(() =>
      guard(async () => {
        const { register } = await import('../../lib/passkey.ts');
        await register(typed === '' ? undefined : typed);
        setName('');
        setNotice(m.account_passkey_add_done());
        await load();
      }),
    );
  };

  const startRename = (item: PasskeyItem) => {
    setNotice('');
    managing.setFailure(null);
    setConfirming(null);
    setRenaming(item.ref);
    setRenameValue(item.name ?? '');
  };

  const rename = (event: FormEvent, ref: string) => {
    event.preventDefault();
    const parsed = PasskeyRenameRequest.safeParse({ name: renameValue });
    if (!parsed.success) {
      managing.setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void managing.run(async () => {
      try {
        const updated = await sendJson('PATCH', `/api/v1/me/passkeys/${ref}`, parsed.data, PasskeyItem);
        setItems((list) => list?.map((p) => (p.ref === ref ? updated : p)) ?? list);
        setRenaming(null);
        setNotice(m.account_passkey_renamed());
      } catch (error) {
        // Gone meanwhile: show the real list next to the message.
        if (error instanceof ApiError && error.status === 404) void load();
        throw error;
      }
    });
  };

  const askRemove = (ref: string) => {
    setNotice('');
    managing.setFailure(null);
    setRenaming(null);
    setConfirming(ref);
  };

  /** Only "Yes" of the question gets here. */
  const remove = (ref: string) => {
    setConfirming(null);
    setNotice('');
    void managing.run(() =>
      guard(async () => {
        try {
          await sendJson('DELETE', `/api/v1/me/passkeys/${ref}`);
        } catch (error) {
          // Already gone (removed elsewhere meanwhile): the list below is the truth.
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        setRenaming(null);
        setNotice(m.account_passkey_removed());
        await load();
        onSessionsEnded();
      }),
    );
  };

  const full = items !== null && items.length >= PASSKEY_MAX;
  return (
    <section className="stack" aria-labelledby="account-passkeys">
      <h2 id="account-passkeys">{m.account_h_passkeys()}</h2>
      <p>{m.account_passkeys_intro()}</p>
      {failed ? <p className="form-error">{m.auth_err_generic()}</p> : null}
      {items === null ? (
        failed ? null : (
          <p aria-live="polite">{m.loading()}</p>
        )
      ) : items.length === 0 ? (
        <p>{m.account_passkeys_none()}</p>
      ) : (
        <ul className="session-list">
          {items.map((p) => {
            const label = p.name ?? m.account_passkey_unnamed({ date: formatDateTime(p.created_at, locale) });
            return (
              <li key={p.ref} className="card">
                <p>
                  <strong>{label}</strong>
                  {p.backed_up ? (
                    <>
                      {' '}
                      <span className="badge">{m.account_passkey_synced()}</span>
                    </>
                  ) : null}
                </p>
                <p className="muted">
                  {m.account_passkey_created({ date: formatDateTime(p.created_at, locale) })}
                  {' · '}
                  {p.last_used_at === null
                    ? m.account_passkey_never_used()
                    : m.account_passkey_last_used({ date: formatDateTime(p.last_used_at, locale) })}
                </p>
                {renaming === p.ref ? (
                  <form method="post" className="stack" onSubmit={(e) => rename(e, p.ref)} noValidate>
                    <Field
                      label={m.field_passkey_name()}
                      error={managing.failure?.fields.name}
                      name="passkey_name"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      maxLength={50}
                      autoComplete="off"
                      required
                    />
                    <div className="cluster">
                      <button type="submit" className="button" disabled={managing.busy}>
                        {m.action_save()}
                      </button>
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={() => {
                          setRenaming(null);
                          managing.setFailure(null);
                        }}
                      >
                        {m.action_cancel()}
                      </button>
                    </div>
                  </form>
                ) : confirming === p.ref ? (
                  <div className="stack">
                    <p>{m.account_passkey_remove_confirm({ name: label })}</p>
                    <div className="cluster">
                      <button type="button" className="button" disabled={managing.busy} onClick={() => remove(p.ref)}>
                        {m.action_yes()}
                      </button>
                      <button
                        ref={keep}
                        type="button"
                        className="button button--quiet"
                        onClick={() => setConfirming(null)}
                      >
                        {m.action_no()}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="cluster">
                    <button
                      type="button"
                      className="button button--quiet"
                      aria-label={m.action_rename_passkey({ name: label })}
                      disabled={managing.busy}
                      onClick={() => startRename(p)}
                    >
                      {m.action_rename()}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      aria-label={m.action_remove_passkey({ name: label })}
                      disabled={managing.busy}
                      onClick={() => askRemove(p.ref)}
                    >
                      {m.action_remove()}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <FormError failure={managing.failure} />
      {full ? (
        <p>{m.account_passkeys_full({ max: String(PASSKEY_MAX) })}</p>
      ) : (
        <form method="post" className="stack" onSubmit={add} noValidate>
          <Field
            label={m.field_passkey_name_optional()}
            hint={m.field_hint_passkey_name()}
            error={adding.failure?.fields.name}
            name="new_passkey_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            autoComplete="off"
          />
          <FormError failure={adding.failure} />
          <div>
            <button type="submit" className="button" disabled={adding.busy || items === null}>
              {m.action_add_passkey()}
            </button>
          </div>
        </form>
      )}
      <p role="status" className="notice">
        {notice}
      </p>
    </section>
  );
}
