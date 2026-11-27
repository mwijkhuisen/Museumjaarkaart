import { m } from '../../paraglide/messages.js';

/** A rating of 1 to 5 as text ("4 van 5"); the glyphs repeat it for the eye and are hidden from assistive technology. */
export function Stars({ rating }: { rating: number }) {
  return (
    <span className="stars">
      <span aria-hidden="true">
        {'★'.repeat(rating)}
        <span className="stars-off">{'★'.repeat(5 - rating)}</span>
      </span>
      <span className="visually-hidden">{m.score_stars({ rating: String(rating) })}</span>
    </span>
  );
}
