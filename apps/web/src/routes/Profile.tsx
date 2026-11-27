import { type PublicMuseum, PublicVisitList, PublicWishlist, UserProfile } from '@mjk/contracts';
import { useState } from 'react';
import type { z } from 'zod';
import { Loading } from '../components/layout/Layout.tsx';
import { ProgressSummary } from '../components/passport/ProgressSummary.tsx';
import { getJson, useApi } from '../lib/api.ts';
import { formatMonth } from '../lib/format.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { apiPath, type Locale, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// A member's public profile (A§10, P2c): server-rendered from the one `UserProfile` answer. The name
// and the museums' names are plain text; there is no avatar, only initials. A list the member keeps
// private is `null` and simply absent. "Meer" fetches the next page of a list in the browser only.

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toLocaleUpperCase();

type Page<T> = { items: T[]; next: string | null };

/** The inline first page plus whatever "meer" has fetched since; the browser only. */
function useMore<T>(first: Page<T>, path: string, schema: z.ZodType<Page<T>>) {
  const [items, setItems] = useState<T[]>(first.items);
  const [next, setNext] = useState<string | null>(first.next);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const more = () => {
    if (next === null || busy) return;
    setBusy(true);
    setFailed(false);
    getJson(`${path}?cursor=${next}`, schema).then(
      (page) => {
        setItems((all) => [...all, ...page.items]);
        setNext(page.next);
        setBusy(false);
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  };
  return { items, next, busy, failed, more };
}

function More({ next, busy, failed, more }: { next: string | null; busy: boolean; failed: boolean; more: () => void }) {
  return (
    <>
      {failed ? (
        <p role="alert" className="form-error">
          {m.profile_more_failed()}
        </p>
      ) : null}
      {next === null ? null : (
        <p>
          <button type="button" className="button button--quiet" disabled={busy} onClick={more}>
            {m.profile_more()}
          </button>
        </p>
      )}
    </>
  );
}

function MuseumLine({ museum, locale }: { museum: PublicMuseum; locale: Locale }) {
  return (
    <>
      <Link href={pathOf({ page: 'museum', locale, slug: museum.slug })}>{museumName(museum, locale)}</Link>
      {museum.place === null ? null : <span className="muted"> · {museum.place}</span>}
    </>
  );
}

function VisitLog({ handle, first, locale }: { handle: string; first: PublicVisitList; locale: Locale }) {
  const { items, ...rest } = useMore(first, `${apiPath.user(handle)}/visits`, PublicVisitList);
  // The API sends the newest month first and the undated visits last: group runs of one month.
  const groups = new Map<string | null, typeof items>();
  for (const v of items) groups.set(v.visited_month, [...(groups.get(v.visited_month) ?? []), v]);
  return (
    <section className="stack" aria-labelledby="profile-visits">
      <h2 id="profile-visits">{m.profile_visits_h()}</h2>
      {items.length === 0 ? <p className="muted">{m.profile_empty()}</p> : null}
      {[...groups].map(([month, visits]) => (
        <div key={month ?? 'undated'}>
          <h3>{month === null ? m.profile_visits_undated() : formatMonth(`${month}-01`, locale)}</h3>
          <ul className="plain-list">
            {visits.map((v) => (
              <li key={v.museum.slug}>
                <MuseumLine museum={v.museum} locale={locale} />
                {v.visits > 1 ? (
                  <span className="muted"> · {m.profile_visit_times({ n: String(v.visits) })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <More {...rest} />
    </section>
  );
}

function Wishlist({ handle, first, locale }: { handle: string; first: PublicWishlist; locale: Locale }) {
  const { items, ...rest } = useMore(first, `${apiPath.user(handle)}/wishlist`, PublicWishlist);
  return (
    <section className="stack" aria-labelledby="profile-wishlist">
      <h2 id="profile-wishlist">{m.profile_wishlist_h()}</h2>
      {items.length === 0 ? <p className="muted">{m.profile_empty()}</p> : null}
      <ul className="plain-list">
        {items.map((w) => (
          <li key={w.museum.slug}>
            <MuseumLine museum={w.museum} locale={locale} />
          </li>
        ))}
      </ul>
      <More {...rest} />
    </section>
  );
}

export function Profile({ route }: { route: Extract<Route, { page: 'profile' }> }) {
  const profile = useApi(apiPath.user(route.handle), UserProfile);
  if (profile === undefined) return <Loading />;
  const { locale } = route;
  const sharesNothing = profile.progress === null && profile.visits === null && profile.wishlist === null;
  return (
    <article className="stack">
      <header className="cluster">
        <span className="avatar" aria-hidden="true">
          {initialsOf(profile.display_name)}
        </span>
        <div>
          <h1>{profile.display_name}</h1>
          <p className="muted">
            @{profile.handle} · {m.profile_member_since({ month: formatMonth(`${profile.member_since}-01`, locale) })}
          </p>
        </div>
      </header>
      {sharesNothing ? <p>{m.profile_nothing_shared({ name: profile.display_name })}</p> : null}
      {profile.progress === null ? null : (
        <section className="stack" aria-labelledby="profile-progress">
          <h2 id="profile-progress">{m.profile_progress_h()}</h2>
          <ProgressSummary progress={profile.progress} locale={locale} />
        </section>
      )}
      {profile.visits === null ? null : <VisitLog handle={profile.handle} first={profile.visits} locale={locale} />}
      {profile.wishlist === null ? null : <Wishlist handle={profile.handle} first={profile.wishlist} locale={locale} />}
    </article>
  );
}
