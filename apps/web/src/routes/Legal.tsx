import { useConfig } from '../lib/config.ts';
import { Link } from '../lib/router.tsx';
import { pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// The interim privacy and contact texts (P1e, accounts and the cookie added in P2a); the terms stay a placeholder
// until P3. "How we check reviews" (P3a, A§11) is a draft until the owner approves it in P3d. The controller and
// the email come from the config as plain text: React escapes them, and the address is only ever a `mailto:` link.

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

function ReviewRules({ locale }: { locale: Extract<Route, { page: 'legal' }>['locale'] }) {
  return (
    <>
      <h1>{m.page_reviews()}</h1>
      <p className="muted">{m.howcheck_draft()}</p>
      <p>{m.howcheck_intro()}</p>
      <h2>{m.howcheck_h_visits()}</h2>
      <p>{m.howcheck_visits()}</p>
      <h2>{m.howcheck_h_once()}</h2>
      <p>{m.howcheck_once()}</p>
      <h2>{m.howcheck_h_scores()}</h2>
      <p>{m.howcheck_mean()}</p>
      <p>{m.howcheck_aspects()}</p>
      <h2>{m.howcheck_h_rank()}</h2>
      <p>{m.howcheck_rank()}</p>
      <p>
        <code>{m.howcheck_formula()}</code>
      </p>
      <p>{m.howcheck_rank_why()}</p>
      <h2>{m.howcheck_h_negative()}</h2>
      <p>{m.howcheck_negative()}</p>
      <h2>{m.howcheck_h_moderation()}</h2>
      <p>{m.howcheck_moderation()}</p>
      <h2>{m.howcheck_h_staff()}</h2>
      <p>{m.howcheck_staff()}</p>
      <h2>{m.howcheck_h_report()}</h2>
      <p>
        {m.howcheck_report()} <Link href={pathOf({ page: 'legal', locale, doc: 'contact' })}>{m.page_contact()}</Link>
      </p>
    </>
  );
}

export function Legal({ route }: { route: Extract<Route, { page: 'legal' }> }) {
  if (route.doc === 'privacy') return <Privacy />;
  if (route.doc === 'contact') return <Contact />;
  if (route.doc === 'reviews') return <ReviewRules locale={route.locale} />;
  return (
    <>
      <h1>{m.page_terms()}</h1>
      <p>{m.legal_soon()}</p>
    </>
  );
}
