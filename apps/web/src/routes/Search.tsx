import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Stub (WP1): WP4 builds the page (the form, and the results through useApi when `q` is set).

export function Search(_: { route: Extract<Route, { page: 'search' }> }) {
  return <h1>{m.page_search()}</h1>;
}
