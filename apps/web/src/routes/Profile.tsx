import {
  type PublicMuseum,
  PublicVisitList,
  PublicWishlist,
  ReviewList as ReviewListSchema,
  UserProfile,
} from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { ProgressSummary } from '../components/passport/ProgressSummary.tsx';
import { ReviewList } from '../components/reviews/ReviewList.tsx';
import { More, useMore } from '../components/ui/more.tsx';
import { useApi } from '../lib/api.ts';
import { formatMonth } from '../lib/format.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { apiPath, type Locale, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// A member's public profile (A§10, P2c): server-rendered from the one `UserProfile` answer. The name
// and the museums' names are plain text; there is no avatar, only initials. A list the member keeps
// private is `null` and simply absent. "Meer" fetches the next page of a list in the browser only.

/** Upper-cased in the page's own locale, never the host's: server and browser agree ("i" is "İ" in Turkish). */
const initialsOf = (name: string, locale: Locale): string =>
  name
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toLocaleUpperCase(locale);

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
  const reviews = useApi(apiPath.userReviews(route.handle), ReviewListSchema);
  if (profile === undefined || reviews === undefined) return <Loading />;
  const { locale } = route;
  const sharesNothing =
    profile.progress === null && profile.visits === null && profile.wishlist === null && reviews.items.length === 0;
  return (
    <article className="stack">
      <header className="cluster">
        <span className="avatar" aria-hidden="true">
          {initialsOf(profile.display_name, locale)}
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
      {reviews.items.length === 0 ? null : (
        <section className="stack" aria-labelledby="profile-reviews">
          <h2 id="profile-reviews">{m.review_profile_h()}</h2>
          <ReviewList first={reviews} path={apiPath.userReviews(profile.handle)} locale={locale} showMuseum />
        </section>
      )}
      {profile.visits === null ? null : <VisitLog handle={profile.handle} first={profile.visits} locale={locale} />}
      {profile.wishlist === null ? null : <Wishlist handle={profile.handle} first={profile.wishlist} locale={locale} />}
    </article>
  );
}
