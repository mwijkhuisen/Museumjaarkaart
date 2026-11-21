import { MuseumList } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { MuseumResults } from '../components/museum/MuseumResults.tsx';
import { IconSearch } from '../components/ui/icons.tsx';
import { useApi } from '../lib/api.ts';
import { GetForm } from '../lib/router.tsx';
import { apiPath, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

type SearchRoute = Extract<Route, { page: 'search' }>;

/** Its own component: the hook runs only when there is a `q` (apiPathsOf fetches nothing without one). */
function Results({ route }: { route: SearchRoute }) {
  const list = useApi(apiPath.museums(route.query), MuseumList);
  return list === undefined ? <Loading /> : <MuseumResults list={list} route={route} />;
}

export function Search({ route }: { route: SearchRoute }) {
  const q = new URLSearchParams(route.query).get('q');
  return (
    <div className="stack">
      <h1>{m.page_search()}</h1>
      <GetForm action={pathOf({ ...route, query: '' })} className="cluster">
        <div className="field">
          <label htmlFor="s-q">{m.field_q()}</label>
          <input id="s-q" name="q" type="search" defaultValue={q ?? ''} />
        </div>
        <button type="submit" className="button">
          <IconSearch /> {m.action_search()}
        </button>
      </GetForm>
      {q === null ? <p>{m.search_hint()}</p> : <Results route={route} />}
    </div>
  );
}
