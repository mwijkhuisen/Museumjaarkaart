import { Me, MePatchRequest, type MeUser, type Settings } from '@mjk/contracts';
import { type FormEvent, useId, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { fieldsOf, useAction } from '../auth/errors.ts';
import { CheckField, FormError } from '../auth/fields.tsx';

// The passport's settings on the account page (A§10): who sees the visit log and the wishlist, whether
// search engines may show the profile, and the card type that € saved uses. One PATCH /me.

function Choice<V extends string>({
  legend,
  hint,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  hint?: string;
  name: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (v: V) => void;
}) {
  const hintId = useId();
  return (
    <fieldset aria-describedby={hint === undefined ? undefined : hintId}>
      <legend>{legend}</legend>
      {hint === undefined ? null : (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      {options.map(([v, label]) => (
        <div className="check" key={v}>
          <input type="radio" id={`${name}-${v}`} name={name} checked={value === v} onChange={() => onChange(v)} />
          <label htmlFor={`${name}-${v}`}>{label}</label>
        </div>
      ))}
    </fieldset>
  );
}

export function PassportSettings({
  user,
  locale,
  onChanged,
}: {
  user: MeUser;
  locale: Locale;
  onChanged: (me: Me) => void;
}) {
  const [s, setS] = useState<Settings>(user.settings);
  const [saved, setSaved] = useState(false);
  const { busy, failure, setFailure, run } = useAction('plain');
  const set = (patch: Partial<Settings>) => {
    setS((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = MePatchRequest.safeParse({
      settings: {
        visits_visibility: s.visits_visibility,
        wishlist_visibility: s.wishlist_visibility,
        profile_indexable: s.profile_indexable,
        card_type: s.card_type,
      },
    });
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
  const visibility = [
    ['private', m.settings_private()],
    ['public', m.settings_public()],
  ] as const;
  return (
    <section className="stack" aria-labelledby="account-passport">
      <h2 id="account-passport">{m.settings_h()}</h2>
      <form method="post" className="stack" onSubmit={submit} noValidate>
        <Choice
          legend={m.settings_visits()}
          hint={m.settings_visibility_hint()}
          name="visits_visibility"
          value={s.visits_visibility}
          options={visibility}
          onChange={(v) => set({ visits_visibility: v })}
        />
        <Choice
          legend={m.settings_wishlist()}
          name="wishlist_visibility"
          value={s.wishlist_visibility}
          options={visibility}
          onChange={(v) => set({ wishlist_visibility: v })}
        />
        <CheckField
          label={m.settings_indexable()}
          name="profile_indexable"
          checked={s.profile_indexable}
          onChange={(e) => set({ profile_indexable: e.target.checked })}
        />
        <p className="field__hint">{m.settings_indexable_hint()}</p>
        <Choice
          legend={m.settings_card_type()}
          name="card_type"
          value={s.card_type}
          options={
            [
              ['adult', m.settings_card_adult()],
              ['under_19', m.settings_card_under_19()],
            ] as const
          }
          onChange={(v) => set({ card_type: v })}
        />
        <FormError failure={failure} />
        <p role="status" className="notice">
          {saved ? m.settings_saved() : ''}
        </p>
        <button type="submit" className="button" disabled={busy}>
          {m.action_save()}
        </button>
      </form>
      <p>
        <Link href={pathOf({ page: 'profile', locale, handle: user.handle })}>{m.settings_view_profile()}</Link>
      </p>
    </section>
  );
}
