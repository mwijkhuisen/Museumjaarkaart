import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// Placeholders (P1e writes the interim privacy and contact texts).

export function Legal({ route }: { route: Extract<Route, { page: 'legal' }> }) {
  const title = { privacy: m.page_privacy, terms: m.page_terms, contact: m.page_contact, reviews: m.page_reviews }[
    route.doc
  ];
  return (
    <>
      <h1>{title()}</h1>
      <p>{m.legal_soon()}</p>
    </>
  );
}
