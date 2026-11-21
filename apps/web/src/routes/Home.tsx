import { MkList, Provinces } from '@mjk/contracts';
import { Loading } from '../components/layout/Layout.tsx';
import { useApi } from '../lib/api.ts';
import { useConfig } from '../lib/config.ts';
import { apiPath, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Stub (WP1): WP4 builds the page.

export function Home(_: { route: Extract<Route, { page: 'home' }> }) {
  const { brand } = useConfig();
  const provinces = useApi(apiPath.provinces, Provinces);
  const list = useApi(apiPath.mkList, MkList);
  if (provinces === undefined || list === undefined) return <Loading />;
  return <h1>{m.head_title_home({ brand })}</h1>;
}
