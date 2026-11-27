import { MuseumDetail, ReviewList as ReviewListSchema } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { ClosureNote } from '../components/museum/ClosureNote.tsx';
import { ReviewList } from '../components/reviews/ReviewList.tsx';
import { ScoreSummary } from '../components/reviews/ScoreSummary.tsx';
import { useApi } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

/** A museum's reviews, newest first, with its score (P3a). A closed museum's reviews still show. */
export function MuseumReviews({ route }: { route: Extract<Route, { page: 'museum-reviews' }> }) {
  const museum = useApi(apiPath.museum(route.slug), MuseumDetail);
  const reviews = useApi(apiPath.museumReviews(route.slug), ReviewListSchema);
  if (museum === undefined || reviews === undefined) return <Loading />;
  const { locale } = route;
  return (
    <article className="stack">
      <h1>
        <Link href={pathOf({ page: 'museum', locale, slug: museum.slug })}>{museumName(museum, locale)}</Link>
      </h1>
      <ClosureNote
        closedOn={museum.closed_on}
        tempClosed={museum.temp_closed}
        tempClosedUntil={museum.temp_closed_until}
        locale={locale}
      />
      <section className="stack" aria-labelledby="reviews-score">
        <h2 id="reviews-score">{m.score_h()}</h2>
        <ScoreSummary museum={museum} locale={locale} />
      </section>
      <section className="stack" aria-labelledby="reviews-list">
        <h2 id="reviews-list">{m.review_list_h()}</h2>
        <ReviewList first={reviews} path={apiPath.museumReviews(route.slug)} locale={locale} />
      </section>
    </article>
  );
}
