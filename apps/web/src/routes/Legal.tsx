import { useConfig } from '../lib/config.ts';
import type { Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The interim privacy and contact texts (P1e, accounts and the cookie added in P2a); the terms and the review
// rules stay placeholders until P3. The controller and the email come from the config as plain text:
// React escapes them, and the address is only ever a `mailto:` link.

function Mail() {
  const { contactEmail } = useConfig();
  return <a href={`mailto:${contactEmail}`}>{contactEmail}</a>;
}

function Privacy() {
  const { controller } = useConfig();
  return (
    <>
      <h1>{m.page_privacy()}</h1>
      <p>{m.privacy_intro()}</p>
      <h2>{m.privacy_h_collect()}</h2>
      <p>{m.privacy_collect()}</p>
      <h2>{m.privacy_h_accounts()}</h2>
      <p>{m.privacy_accounts()}</p>
      <h2>{m.privacy_h_cookie()}</h2>
      <p>{m.privacy_cookie()}</p>
      <h2>{m.privacy_h_location()}</h2>
      <p>{m.privacy_location()}</p>
      <h2>{m.privacy_h_logs()}</h2>
      <p>{m.privacy_logs()}</p>
      <h2>{m.privacy_h_cloudflare()}</h2>
      <p>{m.privacy_cloudflare()}</p>
      <h2>{m.privacy_h_mail()}</h2>
      <p>{m.privacy_mail()}</p>
      <h2>{m.privacy_h_backups()}</h2>
      <p>{m.privacy_backups()}</p>
      <h2>{m.privacy_h_lost()}</h2>
      <p>{m.privacy_lost()}</p>
      <h2>{m.privacy_h_rights()}</h2>
      <p>{m.privacy_rights()}</p>
      <h2>{m.privacy_h_controller()}</h2>
      <p>{m.privacy_controller({ controller })}</p>
      <p>
        {m.privacy_controller_mail()} <Mail />
      </p>
    </>
  );
}

function Contact() {
  const { controller } = useConfig();
  return (
    <>
      <h1>{m.page_contact()}</h1>
      <p>
        {m.contact_lead()} <Mail />
      </p>
      <p>{m.contact_operator({ controller })}</p>
      <p>{m.footer_not_affiliated()}</p>
    </>
  );
}

export function Legal({ route }: { route: Extract<Route, { page: 'legal' }> }) {
  if (route.doc === 'privacy') return <Privacy />;
  if (route.doc === 'contact') return <Contact />;
  const title = { terms: m.page_terms, reviews: m.page_reviews }[route.doc];
  return (
    <>
      <h1>{title()}</h1>
      <p>{m.legal_soon()}</p>
    </>
  );
}
