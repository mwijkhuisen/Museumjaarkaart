import type { Aspect, MuseumDetail } from '@mjk/contracts';
import { ASPECTS } from '@mjk/contracts';
import { formatMean } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { HowWeCheck } from './HowWeCheck.tsx';
import { RatingFold } from './RatingFold.tsx';

const ASPECT_LABEL: Record<Aspect, () => string> = {
  collection: m.score_aspect_collection,
  presentation: m.score_aspect_presentation,
  kid_friendly: m.score_aspect_kid_friendly,
  accessibility: m.score_aspect_accessibility,
  facilities: m.score_aspect_facilities,
  value_for_money: m.score_aspect_value_for_money,
};

/** "12 beoordelingen" / "1 beoordeling". */
export const countText = (count: number): string =>
  count === 1 ? m.score_count_one() : m.score_count_other({ count: String(count) });

/**
 * A museum's score (P3a): the mean, the count and each aspect's mean ("te weinig beoordelingen" below 3
 * ratings), or "Nog geen beoordelingen". The scores sit in a RatingFold; the link to "Hoe wij reviews
 * controleren" is beside it, always visible. `readSlug` (the museum page) adds "Lees de reviews (n)" inside the fold.
 */
export function ScoreSummary({
  museum,
  locale,
  readSlug,
}: {
  museum: Pick<MuseumDetail, 'id' | 'rating_count' | 'rating_mean' | 'aspects'>;
  locale: Locale;
  readSlug?: string;
}) {
  const { rating_count: count, rating_mean: mean } = museum;
  return (
    <div className="score-summary stack">
      {count === 0 || mean === null ? (
        <p className="muted">{m.score_none()}</p>
      ) : (
        <RatingFold museumId={museum.id}>
          <div className="stack">
            <p className="score-mean">
              <strong>{m.score_mean({ mean: formatMean(mean, locale) })}</strong>{' '}
              <span className="muted">{countText(count)}</span>
            </p>
            <dl className="facts score-aspects">
              {ASPECTS.map((a) => {
                const { mean: aspectMean, count: aspectCount } = museum.aspects[a];
                return (
                  <div key={a}>
                    <dt>{ASPECT_LABEL[a]()}</dt>
                    <dd>
                      {aspectMean === null ? (
                        <span className="muted">{m.score_few()}</span>
                      ) : (
                        <>
                          {m.score_mean({ mean: formatMean(aspectMean, locale) })}{' '}
                          <span className="muted">({aspectCount})</span>
                        </>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {readSlug === undefined ? null : (
              <p>
                <Link href={pathOf({ page: 'museum-reviews', locale, slug: readSlug })}>
                  {m.review_read({ count: String(count) })}
                </Link>
              </p>
            )}
          </div>
        </RatingFold>
      )}
      <p>
        <HowWeCheck locale={locale} />
      </p>
    </div>
  );
}
