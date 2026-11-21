import { formatDate } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconClosed } from '../ui/icons.tsx';

/**
 * Closed (`closedOn`) or temporarily closed. `tempClosedUntil`: the date, null for "until further
 * notice", undefined where the data has no such field (a list card): then just "Temporarily closed".
 */
export function ClosureNote({
  closedOn,
  tempClosed,
  tempClosedUntil,
  locale,
}: {
  closedOn: string | null;
  tempClosed: boolean;
  tempClosedUntil?: string | null | undefined;
  locale: Locale;
}) {
  let text: string;
  if (closedOn !== null) text = m.museum_closed_on({ date: formatDate(closedOn, locale) });
  else if (!tempClosed) return null;
  else if (tempClosedUntil === undefined) text = m.museum_temp_closed();
  else if (tempClosedUntil === null) text = m.museum_temp_closed_open_end();
  else text = m.museum_temp_closed_until({ date: formatDate(tempClosedUntil, locale) });
  return (
    <p>
      <IconClosed /> {text}
    </p>
  );
}
