import { MuseumDetail } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { useApi } from '../lib/api.ts';
import { museumName } from '../lib/names.ts';
import { apiPath, type Route } from '../lib/routes.ts';

// Stub (WP1): WP4 builds the page.

export function Museum({ route }: { route: Extract<Route, { page: 'museum' }> }) {
  const museum = useApi(apiPath.museum(route.slug), MuseumDetail);
  if (museum === undefined) return <Loading />;
  return <h1>{museumName(museum, route.locale)}</h1>;
}
