import { Link } from '../lib/router.tsx';
import { pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Placeholder until P1d builds the map (A§15.3).

export function MapPage({ route }: { route: Extract<Route, { page: 'map' }> }) {
  return (
    <div className="stack">
      <h1>{m.page_map()}</h1>
      <p>{m.map_soon()}</p>
      <p>
        <Link href={pathOf({ page: 'museums', locale: route.locale, query: '' })}>{m.map_to_list()}</Link>
      </p>
    </div>
  );
}
