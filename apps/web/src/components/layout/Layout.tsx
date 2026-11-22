import type { ReactNode } from 'react';
import { useConfig } from '../../lib/config.ts';
import { Link } from '../../lib/router.tsx';
import { inLocale, type LegalDoc, type Locale, pathOf, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { IconGlobe } from '../ui/icons.tsx';

// The frame of every page: skip link, header, <main>, footer (A§15.5, A§13.4, ADR-0006).

/** A plain <a>, never Link: a language switch reloads the page (ADR-0013). */
function LanguageLink({ route }: { route: Route }) {
  const other: Locale = route.locale === 'nl' ? 'en' : 'nl';
  return (
    <a href={pathOf(inLocale(route, other))} hrefLang={other} lang={other}>
      <IconGlobe /> {m.lang_switch()}
    </a>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { brand } = useConfig();
  const { locale } = route;
  const page = (r: Route) => pathOf(r);
  const legal = (doc: LegalDoc) => page({ page: 'legal', locale, doc });
  return (
    <>
      <a className="skip-link" href="#main">
        {m.skip_link()}
      </a>
      <header className="site-header">
        <Link href={page({ page: 'home', locale })}>
          <strong>{brand}</strong>
        </Link>
        <nav aria-label={m.nav_main()}>
          <ul className="site-nav">
            <li>
              <Link href={page({ page: 'museums', locale, query: '' })}>{m.page_museums()}</Link>
            </li>
            <li>
              <Link href={page({ page: 'search', locale, query: '' })}>{m.page_search()}</Link>
            </li>
            <li>
              <Link href={page({ page: 'map', locale, query: '' })}>{m.page_map()}</Link>
            </li>
          </ul>
        </nav>
        <LanguageLink route={route} />
      </header>
      <main id="main" tabIndex={-1} className="page">
        {children}
      </main>
      <footer className="site-footer">
        <p>
          <strong>{brand}</strong>
        </p>
        <p>{m.footer_not_affiliated()}</p>
        <p>{m.footer_disclaimer()}</p>
        <nav aria-label={m.nav_footer()}>
          <ul className="site-nav">
            <li>
              <Link href={legal('contact')}>{m.page_contact()}</Link>
            </li>
            <li>
              <Link href={legal('privacy')}>{m.page_privacy()}</Link>
            </li>
            <li>
              <Link href={legal('terms')}>{m.page_terms()}</Link>
            </li>
            <li>
              <Link href={legal('reviews')}>{m.page_reviews()}</Link>
            </li>
            <li>
              <LanguageLink route={route} />
            </li>
          </ul>
        </nav>
      </footer>
    </>
  );
}

/** While a client-side navigation loads its data. */
export function Loading() {
  return <p aria-live="polite">{m.loading()}</p>;
}
