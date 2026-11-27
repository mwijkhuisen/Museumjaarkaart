import { MuseumList, type MuseumListItem } from '@mjk/contracts';
import { useEffect, useState } from 'react';
import { getJson } from '../../lib/api.ts';
import { formatCount } from '../../lib/format.ts';
import { useMarks } from '../../lib/member.ts';
import { Link } from '../../lib/router.tsx';
import { pathOf, provinceQuery, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { Loading } from '../layout/Layout.tsx';
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

function Cards({ items, locale }: { items: readonly MuseumListItem[]; locale: ListRoute['locale'] }) {
  return items.length === 0 ? (
    <p>{m.list_empty()}</p>
  ) : (
    <ul className="card-list">
      {items.map((museum) => (
        <li key={museum.id}>
          <MuseumCard museum={museum} locale={locale} />
        </li>
      ))}
    </ul>
  );
}

// A member's own filters ("bezocht", "nog niet bezocht", "op mijn verlanglijst"): client state, shown
// only once the marks are known (A§15.1), and never in the URL (`KEPT` in lib/routes.ts is unchanged).
// Their slot is rendered for everyone, empty until then, so the list below never shifts.
// ponytail: a new search or province navigation remounts the page and resets them.
type Filter = { visited: 'all' | 'yes' | 'no'; wishlist: boolean };
const OFF: Filter = { visited: 'all', wishlist: false };

function MarkFilters({ filter, onChange }: { filter: Filter; onChange: (filter: Filter) => void }) {
  const radio = (value: Filter['visited'], label: string) => (
    <label>
      <input
        type="radio"
        name="marks-visited"
        checked={filter.visited === value}
        onChange={() => onChange({ ...filter, visited: value })}
      />{' '}
      {label}
    </label>
  );
  return (
    <fieldset className="marks-filter">
      <legend>{m.filter_mine()}</legend>
      {radio('all', m.filter_all())}
      {radio('yes', m.marks_visited())}
      {radio('no', m.filter_not_visited())}
      <label>
        <input
          type="checkbox"
          checked={filter.wishlist}
          onChange={(e) => onChange({ ...filter, wishlist: e.target.checked })}
        />{' '}
        {m.filter_wishlist()}
      </label>
    </fieldset>
  );
}

type Page = { key: string; items: MuseumListItem[]; total: number; next: string | null } | 'failed';

/** The page's own query (without its cursor) plus the filter, answered by `GET /me/museums`; "more" appends. */
function FilteredResults({ route, filter }: { route: ListRoute; filter: Filter }) {
  const query = new URLSearchParams(route.page === 'province' ? provinceQuery(route) : route.query);
  query.delete('cursor');
  if (filter.visited !== 'all') query.set('visited', filter.visited);
  if (filter.wishlist) query.set('wishlist', 'yes');
  const key = query.toString();
  const [page, setPage] = useState<Page | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let live = true;
    getJson(`/api/v1/me/museums?${key}`, MuseumList).then(
      (l) => live && setPage({ key, items: l.items, total: l.total, next: l.next_cursor }),
      () => live && setPage('failed'),
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (page === 'failed') return <p role="alert">{m.marks_failed()}</p>;
  if (page === null || page.key !== key) return <Loading />;
  const load = async () => {
    setMore(true);
    try {
      const l = await getJson(`/api/v1/me/museums?${key}&cursor=${encodeURIComponent(page.next ?? '')}`, MuseumList);
      setPage({ key, items: [...page.items, ...l.items], total: l.total, next: l.next_cursor });
    } catch {
      setPage('failed');
    } finally {
      setMore(false);
    }
  };
  return (
    <>
      <p>{m.list_total({ count: formatCount(page.total, route.locale) })}</p>
      <Cards items={page.items} locale={route.locale} />
      {page.next === null ? null : (
        <button type="button" className="button" disabled={more} onClick={() => void load()}>
          {m.filter_more()}
        </button>
      )}
    </>
  );
}

/** The total, the cards, the pager, or the empty state: shared by the list, province and search pages. */
export function MuseumResults({ list, route }: { list: MuseumList; route: ListRoute }) {
  const marks = useMarks();
  const [filter, setFilter] = useState<Filter>(OFF);
  const filtered = marks !== undefined && (filter.visited !== 'all' || filter.wishlist);
  return (
    <>
      <div className="marks-filter-slot">
        {marks === undefined ? null : <MarkFilters filter={filter} onChange={setFilter} />}
      </div>
      {filtered ? (
        <FilteredResults route={route} filter={filter} />
      ) : (
        <>
          <p>{m.list_total({ count: formatCount(list.total, route.locale) })}</p>
          <Cards items={list.items} locale={route.locale} />
          <Pager route={route} nextCursor={list.next_cursor} />
        </>
      )}
    </>
  );
}
