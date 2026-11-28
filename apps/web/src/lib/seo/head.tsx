import { MuseumDetail, Provinces, PublicReview, type SsrConfig, UserProfile } from '@mjk/contracts';
import { m } from '../../paraglide/messages.js';
import { formatMonth } from '../format.ts';
import { mediaOrigin } from '../media.ts';
import { museumName, provinceName } from '../names.ts';
import { apiPath, inLocale, type Locale, PROVINCE_SLUGS, pathOf, type Route } from '../routes.ts';
import { museumJsonLd } from './jsonld.ts';

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
  controller: string;
  contactEmail: string;
  /** `https://media.<domain>`: where the photos are (the CSP's `img-src`). */
  media: string;
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
    case 'museum-reviews':
      return pageTitle(
        m.review_head_title({
          name: museumName(MuseumDetail.parse(data.get(apiPath.museum(route.slug))), route.locale),
        }),
        brand,
      );
    case 'review':
      return pageTitle(
        m.review_single_h({
          name: museumName(PublicReview.parse(data.get(apiPath.review(route.id))).museum, route.locale),
        }),
        brand,
      );
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
        {
          passport: m.page_passport,
          wishlist: m.page_wishlist,
          account: m.page_account,
          signin: m.page_signin,
          welcome: m.page_welcome,
        }[route.app](),
        brand,
      );
    case 'profile':
      return pageTitle(profileOf(route, data).display_name, brand);
    case 'not_found':
      return pageTitle(m.page_not_found(), brand);
  }
}

const absolute = (route: Route, config: SsrConfig) => `https://${config.domain}${pathOf(route)}`;

const profileOf = (route: Extract<Route, { page: 'profile' }>, data: PageData) =>
  UserProfile.parse(data.get(apiPath.user(route.handle)));

const museumOf = (route: Extract<Route, { page: 'museum' }>, data: PageData) =>
  MuseumDetail.parse(data.get(apiPath.museum(route.slug)));

/** A museum's description in the page's language, else Dutch, else a line from name and place. */
function museumDescription(museum: MuseumDetail, locale: Locale): string {
  const own = locale === 'en' ? museum.description_en : museum.description_nl;
  const text = own ?? museum.description_nl;
  if (text !== null) return text;
  const name = museumName(museum, locale);
  return museum.place === null
    ? m.head_description_museum_noplace({ name })
    : m.head_description_museum({ name, place: museum.place });
}

function descriptionOf(route: Route, data: PageData): string | null {
  switch (route.page) {
    case 'home':
      return m.head_description_home();
    case 'museums':
      return m.head_description_museums();
    case 'museum':
      return museumDescription(museumOf(route, data), route.locale);
    case 'museum-reviews':
      return m.review_head_description({
        name: museumName(MuseumDetail.parse(data.get(apiPath.museum(route.slug))), route.locale),
      });
    case 'province': {
      const code = PROVINCE_SLUGS[route.province];
      const province = Provinces.parse(data.get(apiPath.provinces)).items.find((p) => p.code === code);
      return m.head_description_province({ province: province ? provinceName(province, route.locale) : '' });
    }
    case 'map':
      return m.head_description_map();
    case 'profile': {
      const profile = profileOf(route, data);
      return m.profile_head_description({
        name: profile.display_name,
        month: formatMonth(`${profile.member_since}-01`, route.locale),
      });
    }
    default:
      return null;
  }
}

/**
 * `noindex` for the app shell, `noindex, follow` for search and for a single review (thin content that names a
 * member; a museum's reviews page is indexable), and for a profile unless its member opted in (Q2).
 */
function robotsOf(route: Route, data: PageData): string | null {
  if (route.page === 'shell') return 'noindex';
  if (route.page === 'search' || route.page === 'review') return 'noindex, follow';
  if (route.page === 'profile') return profileOf(route, data).indexable ? null : 'noindex';
  return null;
}

/** The head of a 200 page: description, canonical, the hreflang pair and Open Graph (A§15.2). */
export function headOf(route: Route, data: PageData, config: SsrConfig): HeadData {
  return {
    locale: route.locale,
    title: titleOf(route, data, config.brand),
    description: descriptionOf(route, data),
    canonical: absolute(route, config),
    alternates: { nl: absolute(inLocale(route, 'nl'), config), en: absolute(inLocale(route, 'en'), config) },
    robots: robotsOf(route, data),
    brand: config.brand,
    controller: config.controller,
    contactEmail: config.contactEmail,
    media: mediaOrigin(config.domain),
  };
}

export type ErrorKind = 'not_found' | 'bad_request' | 'error';

/** The title of an error page; also the SPA's after a failed in-place navigation. */
export const errorTitleOf = (kind: ErrorKind, brand: string): string =>
  pageTitle({ not_found: m.page_not_found, bad_request: m.page_bad_request, error: m.page_error }[kind](), brand);

/** The head of an error document: a title, never indexed. */
export function errorHeadOf(kind: ErrorKind, locale: Locale, config: SsrConfig): HeadData {
  return {
    locale,
    title: errorTitleOf(kind, config.brand),
    description: null,
    canonical: null,
    alternates: null,
    robots: 'noindex',
    brand: config.brand,
    controller: config.controller,
    contactEmail: config.contactEmail,
    media: mediaOrigin(config.domain),
  };
}

/** The JSON-LD `Museum` object of a museum page, else null. */
export function jsonLdOf(route: Route, data: PageData, config: SsrConfig): object | null {
  if (route.page !== 'museum') return null;
  const museum = museumOf(route, data);
  return museumJsonLd(museum, route.locale, absolute(route, config), museumDescription(museum, route.locale));
}

const OG_LOCALE = { nl: 'nl_NL', en: 'en_GB' } as const;

/** The head elements, rendered to static markup by the server (React escapes every value). */
export function Head({ head }: { head: HeadData }) {
  const other = head.locale === 'nl' ? 'en' : 'nl';
  return (
    <>
      <title>{head.title}</title>
      <meta name="application-name" content={head.brand} />
      <meta name="mjk-controller" content={head.controller} />
      <meta name="mjk-contact" content={head.contactEmail} />
      <meta name="mjk-media" content={head.media} />
      {head.robots === null ? null : <meta name="robots" content={head.robots} />}
      {head.description === null ? null : <meta name="description" content={head.description} />}
      {head.canonical === null ? null : <link rel="canonical" href={head.canonical} />}
      {head.alternates === null ? null : (
        <>
          <link rel="alternate" hrefLang="nl" href={head.alternates.nl} />
          <link rel="alternate" hrefLang="en" href={head.alternates.en} />
          <link rel="alternate" hrefLang="x-default" href={head.alternates.nl} />
        </>
      )}
      {head.canonical === null ? null : (
        <>
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content={head.brand} />
          <meta property="og:title" content={head.title} />
          {head.description === null ? null : <meta property="og:description" content={head.description} />}
          <meta property="og:url" content={head.canonical} />
          <meta property="og:locale" content={OG_LOCALE[head.locale]} />
          <meta property="og:locale:alternate" content={OG_LOCALE[other]} />
        </>
      )}
    </>
  );
}
