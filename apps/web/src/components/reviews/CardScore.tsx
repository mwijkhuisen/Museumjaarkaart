import type { MuseumListItem } from '@mjk/contracts';
import { formatMean } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { HowWeCheck } from './HowWeCheck.tsx';
import { RatingFold } from './RatingFold.tsx';
import { countText } from './ScoreSummary.tsx';

/**
 * The mean and the count on a list card (P3a, N3): its own fold and its own link to "Hoe wij reviews
 * controleren" (an info icon whose accessible name is the full text). Nothing at all without a rating.
 */
export function CardScore({
  museum,
  locale,
}: {
  museum: Pick<MuseumListItem, 'id' | 'rating_count' | 'rating_mean'>;
  locale: Locale;
}) {
  const { rating_count: count, rating_mean: mean } = museum;
  if (count === 0 || mean === null) return null;
  const text = formatMean(mean, locale);
  return (
    <div className="card-score cluster">
      <RatingFold museumId={museum.id} compact>
        <span aria-hidden="true">
          <span className="stars">★</span> <strong>{text}</strong> <span className="muted">({count})</span>
        </span>
        <span className="visually-hidden">
          {m.score_mean({ mean: text })}, {countText(count)}
        </span>
      </RatingFold>
      <HowWeCheck locale={locale} icon />
    </div>
  );
}
