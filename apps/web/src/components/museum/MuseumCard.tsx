import type { MuseumListItem } from '@mjk/contracts';
import { museumName } from '../../lib/names.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { CardScore } from '../reviews/CardScore.tsx';
import { IconMapPin } from '../ui/icons.tsx';
import { ClosureNote } from './ClosureNote.tsx';
import { MuseumkaartStatus } from './MuseumkaartStatus.tsx';
import { MarkSlot } from './MuseumMarks.tsx';

export function MuseumCard({ museum, locale }: { museum: MuseumListItem; locale: Locale }) {
  return (
    <article className="card stack">
      <h2>
        <Link href={pathOf({ page: 'museum', locale, slug: museum.slug })}>{museumName(museum, locale)}</Link>
      </h2>
      {museum.place === null ? null : (
        <p className="muted">
          <IconMapPin /> {museum.place}
        </p>
      )}
      <p>
        <MuseumkaartStatus status={museum.museumkaart_status} locale={locale} />
      </p>
      <CardScore museum={museum} locale={locale} />
      <ClosureNote closedOn={museum.closed_on} tempClosed={museum.temp_closed} locale={locale} />
      <MarkSlot museumId={museum.id} name={museumName(museum, locale)} />
    </article>
  );
}
