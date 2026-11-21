import type { ReactNode } from 'react';
import type { Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';

// Stub (WP1): WP4 adds the header (brand, search, language link) and the footer lines.

export function Layout({ children }: { route: Route; children: ReactNode }) {
  return (
    <>
      <header />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer />
    </>
  );
}

/** While a client-side navigation loads its data. */
export function Loading() {
  return <p aria-live="polite">{m.loading()}</p>;
}
