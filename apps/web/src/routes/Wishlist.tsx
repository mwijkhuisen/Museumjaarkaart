import { Wishlist as WishlistSchema } from '@mjk/contracts';
import { useState } from 'react';
import { useAction } from '../components/auth/errors.ts';
import { FormError } from '../components/auth/fields.tsx';
import { LoadFailed, MemberPage, useJson } from '../components/passport/MemberPage.tsx';
import { MuseumRef } from '../components/passport/Savings.tsx';
import { sendJson } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import type { Locale, Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The member's wishlist (A§10): the museums, each with a remove button.

export function Wishlist({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  return (
    <MemberPage route={route} title={m.page_wishlist()}>
      <WishlistBody locale={route.locale} />
    </MemberPage>
  );
}

function WishlistBody({ locale }: { locale: Locale }) {
  const { data, failed, reload } = useJson('/api/v1/me/wishlist', WishlistSchema);
  const [gone, setGone] = useState<readonly string[]>([]);
  const { busy, failure, run } = useAction('plain');

  if (failed) return <LoadFailed onRetry={reload} />;
  if (data === undefined) return <p aria-live="polite">{m.loading()}</p>;
  const items = data.items.filter((i) => !gone.includes(i.museum.id));
  if (items.length === 0) return <p>{m.wishlist_empty()}</p>;
  return (
    <>
      <FormError failure={failure} />
      <ul className="plain-list stack">
        {items.map((item) => (
          <li key={item.museum.id} className="card cluster">
            <span>
              <MuseumRef museum={item.museum} locale={locale} />
              {item.museum.place === null ? null : <span className="muted"> · {item.museum.place}</span>}
            </span>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              aria-label={m.wishlist_remove_named({ name: museumName(item.museum, locale) })}
              onClick={() =>
                void run(async () => {
                  await sendJson('DELETE', `/api/v1/me/wishlist/${item.museum.id}`);
                  setGone((old) => [...old, item.museum.id]);
                })
              }
            >
              {m.wishlist_remove()}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
