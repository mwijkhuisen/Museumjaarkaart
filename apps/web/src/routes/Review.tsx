import { PublicReview } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { ReviewCard } from '../components/reviews/ReviewCard.tsx';
import { useApi } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

/** One review on its own page (P3a); the head says `noindex, follow`: thin content that names a member. */
export function Review({ route }: { route: Extract<Route, { page: 'review' }> }) {
  const review = useApi(apiPath.review(route.id), PublicReview);
  if (review === undefined) return <Loading />;
  const { locale } = route;
  const name = museumName(review.museum, locale);
  return (
    <article className="stack">
      <h1>{m.review_single_h({ name })}</h1>
      <ReviewCard review={review} locale={locale} />
      <p className="cluster">
        <Link href={pathOf({ page: 'museum', locale, slug: review.museum.slug })}>{name}</Link>
        <Link href={pathOf({ page: 'museum-reviews', locale, slug: review.museum.slug })}>{m.review_all_of()}</Link>
      </p>
    </article>
  );
}
