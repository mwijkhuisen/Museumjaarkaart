import type { MuseumList } from '@mjk/contracts';
import { formatCount } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { pathOf, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconChevronRight } from '../ui/icons.tsx';
import { MuseumCard } from './MuseumCard.tsx';

type ListRoute = Extract<Route, { page: 'museums' | 'map' | 'province' | 'search' }>;

/** The "next page" link: the route's own query, with `cursor` set. */
export function Pager({ route, nextCursor }: { route: ListRoute; nextCursor: string | null }) {
  if (nextCursor === null) return null;
  const query = new URLSearchParams(route.query);
  query.set('cursor', nextCursor);
  return (
    <nav className="pager" aria-label={m.pager_next()}>
      <Link href={pathOf({ ...route, query: query.toString() })} rel="next">
        {m.pager_next()} <IconChevronRight />
      </Link>
    </nav>
  );
}

/** The total, the cards, the pager, or the empty state: shared by the list, province and search pages. */
export function MuseumResults({ list, route }: { list: MuseumList; route: ListRoute }) {
  return (
    <>
      <p>{m.list_total({ count: formatCount(list.total, route.locale) })}</p>
      {list.items.length === 0 ? (
        <p>{m.list_empty()}</p>
      ) : (
        <ul className="card-list">
          {list.items.map((museum) => (
            <li key={museum.id}>
              <MuseumCard museum={museum} locale={route.locale} />
            </li>
          ))}
        </ul>
      )}
      <Pager route={route} nextCursor={list.next_cursor} />
    </>
  );
}
