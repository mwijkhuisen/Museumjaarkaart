import { ASPECTS, type Aspect, type PublicReview } from '@mjk/contracts';
import { formatDate, formatDay } from '../../lib/format.ts';
import { museumName } from '../../lib/names.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { PhotoGrid } from '../photos/Picture.tsx';
import { HowWeCheck } from './HowWeCheck.tsx';
import { RatingFold } from './RatingFold.tsx';
import { Stars } from './Stars.tsx';

const ASPECT_LABEL: Record<Aspect, () => string> = {
  collection: m.score_aspect_collection,
  presentation: m.score_aspect_presentation,
  kid_friendly: m.score_aspect_kid_friendly,
  accessibility: m.score_aspect_accessibility,
  facilities: m.score_aspect_facilities,
  value_for_money: m.score_aspect_value_for_money,
};

function Author({ review, locale }: { review: PublicReview; locale: Locale }) {
  const { author } = review;
  if (author.former_member) return m.review_former_member();
  const name = author.display_name ?? '';
  // A banned member's name stays as text, never a link to a profile that no longer answers.
  return author.handle !== null && author.active ? (
    <Link href={pathOf({ page: 'profile', locale, handle: author.handle })}>{name}</Link>
  ) : (
    name
  );
}

/**
 * One review (P3a, D17, N2): the rating as text, the aspects that were set, the body as ONE text node (never
 * markup, never `<br>`: CSS keeps its line breaks), the author, the full visit date and a link to the review's
 * own page. The whole card sits in the fold of its own museum (the profile's list spans many museums); the
 * link to "Hoe wij reviews controleren" is beside it. `showMuseum`: the museum's name and link, for lists that
 * span museums.
 */
export function ReviewCard({
  review,
  locale,
  showMuseum = false,
}: {
  review: PublicReview;
  locale: Locale;
  showMuseum?: boolean;
}) {
  const aspects = ASPECTS.filter((a) => review[a] !== null);
  return (
    <article className="review-card stack">
      {showMuseum ? (
        <h3>
          <Link href={pathOf({ page: 'museum', locale, slug: review.museum.slug })}>
            {museumName(review.museum, locale)}
          </Link>
        </h3>
      ) : null}
      <RatingFold museumId={review.museum.id}>
        <div className="stack">
          <p>
            <Stars rating={review.rating} />
          </p>
          {aspects.length === 0 ? null : (
            <ul className="review-aspects plain-list">
              {aspects.map((a) => (
                <li key={a}>
                  {ASPECT_LABEL[a]()}: <Stars rating={review[a] as number} />
                </li>
              ))}
            </ul>
          )}
          {review.body === null ? null : (
            <p className="review-body" dir="auto">
              {review.body}
            </p>
          )}
          <PhotoGrid photos={review.photos} museum={museumName(review.museum, locale)} handle={review.author.handle} />
          <p className="muted review-meta">
            <Author review={review} locale={locale} />
            {' · '}
            {review.visited_on === null
              ? m.review_visited()
              : m.review_visited_on({ date: formatDate(review.visited_on, locale) })}
            {' · '}
            {m.review_written({ date: formatDay(review.created_at, locale) })}
            {review.edited_at === null ? null : (
              <>
                {' · '}
                {m.review_edited({ date: formatDay(review.edited_at, locale) })}
              </>
            )}
          </p>
          <p>
            <Link href={pathOf({ page: 'review', locale, id: review.id })}>{m.review_permalink()}</Link>
          </p>
        </div>
      </RatingFold>
      <p>
        <HowWeCheck locale={locale} />
      </p>
    </article>
  );
}
