import { MuseumList, Provinces } from '@mjk/contracts';
import { useEffect, useState } from 'react';
import { Loading } from '../components/layout/Layout.tsx';
import { MuseumMap } from '../components/map/MuseumMap.tsx';
import { MuseumFilters } from '../components/museum/MuseumFilters.tsx';
import { MuseumResults } from '../components/museum/MuseumResults.tsx';
import { NearMe } from '../components/near-me/NearMe.tsx';
import { useApi } from '../lib/api.ts';
import { type MapView, moveTo } from '../lib/map/museumLayer.ts';
import { apiPath, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The map page (A§15.3). Server-rendered: the heading, the filters, the list of the same museums
// (from `mjk-state`) and a note for browsers without JavaScript. With JavaScript, after hydration,
// the near-me button (when the browser has a position API) and the map appear. The list is the
// keyboard and no-JavaScript way to every museum (WCAG 2.5.7): the map is never the only way.

const NEAR_ZOOM = 11;

export function MapPage({ route }: { route: Extract<Route, { page: 'map' }> }) {
  const list = useApi(apiPath.museums(route.query), MuseumList);
  const provinces = useApi(apiPath.provinces, Provinces);
  const [client, setClient] = useState(false);
  const [view, setView] = useState<MapView | null>(null);
  useEffect(() => setClient(true), []);
  if (list === undefined || provinces === undefined) return <Loading />;
  const centre = (lat: number, lon: number) => {
    if (view !== null) moveTo(view, [lon, lat], NEAR_ZOOM);
  };
  return (
    <>
      <h1>{m.page_map()}</h1>
      <MuseumFilters route={route} provinces={provinces} />
      {client ? <NearMe locale={route.locale} onLocated={centre} /> : null}
      <noscript>
        <p>{m.map_needs_js()}</p>
      </noscript>
      {client ? <MuseumMap route={route} onView={setView} /> : null}
      <h2 id="museum-list-heading">{m.map_list_heading()}</h2>
      <MuseumResults list={list} route={route} />
    </>
  );
}
