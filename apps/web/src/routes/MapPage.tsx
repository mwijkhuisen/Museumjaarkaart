import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Placeholder until P1d builds the map (A§15.3).

export function MapPage(_: { route: Extract<Route, { page: 'map' }> }) {
  return <h1>{m.page_map()}</h1>;
}
