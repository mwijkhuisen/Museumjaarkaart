import { MuseumList, Provinces } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { MuseumFilters } from '../components/museum/MuseumFilters.tsx';
import { MuseumResults } from '../components/museum/MuseumResults.tsx';
import { useApi } from '../lib/api.ts';
import { apiPath, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

export function Museums({ route }: { route: Extract<Route, { page: 'museums' }> }) {
  const list = useApi(apiPath.museums(route.query), MuseumList);
  const provinces = useApi(apiPath.provinces, Provinces);
  if (list === undefined || provinces === undefined) return <Loading />;
  return (
    <>
      <h1>{m.page_museums()}</h1>
      <MuseumFilters route={route} provinces={provinces} />
      <MuseumResults list={list} route={route} />
    </>
  );
}
