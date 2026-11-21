import type { MuseumkaartStatus as Status } from '@mjk/contracts';
import { formatMonth } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconCheck, IconCross, IconQuestion } from '../ui/icons.tsx';

// An icon plus a word, never colour alone (A§15.5). Chosen by name, never m[status].
const VIEW = {
  participating: { word: m.mk_participating, Icon: IconCheck },
  left: { word: m.mk_left, Icon: IconCross },
  unknown: { word: m.mk_unknown, Icon: IconQuestion },
} as const;

/** `listDate`: the ISO date of the Museumkaart list the status was checked against, when known. */
export function MuseumkaartStatus({
  status,
  listDate,
  locale,
}: {
  status: Status;
  listDate?: string | undefined;
  locale: Locale;
}) {
  const { word, Icon } = VIEW[status];
  return (
    <>
      <span className={`badge badge--${status}`}>
        <Icon /> {word()}
      </span>
      {listDate === undefined ? null : (
        <span className="muted"> · {m.mk_list_date({ date: formatMonth(listDate, locale) })}</span>
      )}
    </>
  );
}
