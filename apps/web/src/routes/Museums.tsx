import { MuseumList, Provinces } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { useApi } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import { apiPath, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Stub (WP1): WP4 builds the page.

export function Museums({ route }: { route: Extract<Route, { page: 'museums' }> }) {
  const list = useApi(apiPath.museums(route.query), MuseumList);
  const provinces = useApi(apiPath.provinces, Provinces);
  if (list === undefined || provinces === undefined) return <Loading />;
  return (
    <>
      <h1>{m.page_museums()}</h1>
      <ul>
        {list.items.map((museum) => (
          <li key={museum.id}>{museumName(museum, route.locale)}</li>
        ))}
      </ul>
    </>
  );
}
