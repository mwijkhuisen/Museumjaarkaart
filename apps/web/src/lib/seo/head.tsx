import { MuseumDetail, Provinces, type SsrConfig } from '@mjk/contracts';
import { m } from '../../paraglide/messages.js';
import { museumName, provinceName } from '../names.ts';
import { apiPath, type Locale, PROVINCE_SLUGS, type Route } from '../routes.ts';

// The document head (A§15.1): built on the server only, from the route and the same API data the
// page renders. The client keeps only the title in step after an in-place navigation (titleOf).
// Messages run inside the render's locale (entry-server.tsx).

/** Data by API path, as in `mjk-state`. */
export type PageData = ReadonlyMap<string, unknown>;

export type HeadData = {
  locale: Locale;
  title: string;
  description: string | null;
  /** Absolute URLs on `https://<domain>`; null on error pages. */
  canonical: string | null;
  alternates: { nl: string; en: string } | null;
  /** `noindex` for the app shell, `noindex, follow` for search (A§15.2). */
  robots: string | null;
  brand: string;
};

const pageTitle = (page: string, brand: string) => m.head_title({ page, brand });

/** The document title of a page; the same on the server and after a client-side navigation. */
export function titleOf(route: Route, data: PageData, brand: string): string {
  switch (route.page) {
    case 'home':
      return m.head_title_home({ brand });
    case 'museums':
      return pageTitle(m.page_museums(), brand);
    case 'museum':
      return pageTitle(museumName(MuseumDetail.parse(data.get(apiPath.museum(route.slug))), route.locale), brand);
    case 'province': {
      const code = PROVINCE_SLUGS[route.province];
      const province = Provinces.parse(data.get(apiPath.provinces)).items.find((p) => p.code === code);
      return pageTitle(m.page_province({ province: province ? provinceName(province, route.locale) : '' }), brand);
    }
    case 'search': {
      const q = new URLSearchParams(route.query).get('q');
      return pageTitle(q === null ? m.page_search() : m.page_search_results({ q }), brand);
    }
    case 'map':
      return pageTitle(m.page_map(), brand);
    case 'legal':
      return pageTitle(
        { privacy: m.page_privacy, terms: m.page_terms, contact: m.page_contact, reviews: m.page_reviews }[route.doc](),
        brand,
      );
    case 'shell':
      return pageTitle(
        { passport: m.page_passport, wishlist: m.page_wishlist, account: m.page_account, signin: m.page_signin }[
          route.app
        ](),
        brand,
      );
    case 'not_found':
      return pageTitle(m.page_not_found(), brand);
  }
}

/** The head of a 200 page. WP5 fills description, canonical, alternates and Open Graph. */
export function headOf(route: Route, data: PageData, config: SsrConfig): HeadData {
  return {
    locale: route.locale,
    title: titleOf(route, data, config.brand),
    description: null,
    canonical: null,
    alternates: null,
    robots: route.page === 'shell' ? 'noindex' : route.page === 'search' ? 'noindex, follow' : null,
    brand: config.brand,
  };
}

export type ErrorKind = 'not_found' | 'bad_request' | 'error';

/** The head of an error document: a title, never indexed. */
export function errorHeadOf(kind: ErrorKind, locale: Locale, config: SsrConfig): HeadData {
  const page = { not_found: m.page_not_found, bad_request: m.page_bad_request, error: m.page_error }[kind]();
  return {
    locale,
    title: pageTitle(page, config.brand),
    description: null,
    canonical: null,
    alternates: null,
    robots: 'noindex',
    brand: config.brand,
  };
}

/** The JSON-LD `Museum` object of a museum page (WP5), else null. */
export function jsonLdOf(_route: Route, _data: PageData, _config: SsrConfig): object | null {
  return null;
}

/** The head elements, rendered to static markup by the server (React escapes every value). */
export function Head({ head }: { head: HeadData }) {
  return (
    <>
      <title>{head.title}</title>
      <meta name="application-name" content={head.brand} />
      {head.robots === null ? null : <meta name="robots" content={head.robots} />}
    </>
  );
}
