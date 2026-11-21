import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The app shell for the logged-in routes (A§15.1): one HTML for everyone; the SPA screens arrive
// from P2a. Stub (WP1): WP4 writes the placeholder.

export function Shell({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  const title = {
    passport: m.page_passport,
    wishlist: m.page_wishlist,
    account: m.page_account,
    signin: m.page_signin,
  }[route.app];
  return <h1>{title()}</h1>;
}
