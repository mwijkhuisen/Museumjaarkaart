import { ReviewList as ReviewListSchema } from '@mjk/contracts';
import type { z } from 'zod';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { More, useMore } from '../ui/more.tsx';
import { ReviewCard } from './ReviewCard.tsx';

// The list answers `next_cursor`; the shared "Meer" helper speaks `next`.
const NextPage = ReviewListSchema.transform((l) => ({ items: l.items, next: l.next_cursor }));

/**
 * The reviews, newest first (Q5). The first page is the server's; "Meer" fetches `?cursor=` in the browser
 * (the profile's way). `showMuseum` for a list that spans museums.
 */
export function ReviewList({
  first,
  path,
  locale,
  showMuseum = false,
}: {
  first: z.output<typeof ReviewListSchema>;
  /** The API path the list came from; the next pages are `<path>?cursor=…`. */
  path: string;
  locale: Locale;
  showMuseum?: boolean;
}) {
  const { items, ...rest } = useMore({ items: first.items, next: first.next_cursor }, path, NextPage);
  return (
    <div className="stack">
      {items.length === 0 ? <p className="muted">{m.review_none()}</p> : null}
      <ul className="review-list plain-list stack">
        {items.map((review) => (
          <li key={review.id}>
            <ReviewCard review={review} locale={locale} showMuseum={showMuseum} />
          </li>
        ))}
      </ul>
      <More {...rest} />
    </div>
  );
}
