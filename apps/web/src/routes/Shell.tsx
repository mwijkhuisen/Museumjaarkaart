import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The app shell for the logged-in routes (A§15.1): one HTML for everyone. The sign-in and account
// screens are SignIn.tsx and Account.tsx (P2a); the passport, the wishlist and the welcome page stay
// placeholders until P2c (WP9).

export function Shell({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  const title = {
    passport: m.page_passport,
    wishlist: m.page_wishlist,
    account: m.page_account,
    signin: m.page_signin,
    welcome: m.page_welcome,
  }[route.app];
  return (
    <>
      <h1>{title()}</h1>
      <p>{m.shell_soon()}</p>
    </>
  );
}
