import { type ProvinceCode, SLUG_MAX, SLUG_RE } from '@mjk/contracts';

// The one route table (A§15.2, F1's routeOf), shared by the `ssr` role (through the SSR bundle)
// and the client. Pure: no DOM, no fetch. NL at `/`, EN under `/en/`; the locale comes from the
// URL only (ADR-0013).

export type Locale = 'nl' | 'en';
export type LegalDoc = 'privacy' | 'terms' | 'contact' | 'reviews';
export type ShellApp = 'passport' | 'wishlist' | 'account' | 'signin';

/** Province slugs from the Dutch name in both languages (owner, Q4). */
export const PROVINCE_SLUGS = {
  drenthe: 'NL-DR',
  flevoland: 'NL-FL',
  fryslan: 'NL-FR',
  gelderland: 'NL-GE',
  groningen: 'NL-GR',
  limburg: 'NL-LI',
  'noord-brabant': 'NL-NB',
  'noord-holland': 'NL-NH',
  overijssel: 'NL-OV',
  utrecht: 'NL-UT',
  zeeland: 'NL-ZE',
  'zuid-holland': 'NL-ZH',
} as const satisfies Record<string, ProvinceCode>;
export type ProvinceSlug = keyof typeof PROVINCE_SLUGS;

export type Route =
  | { page: 'home'; locale: Locale }
  /** `query`: the kept list parameters, URL-encoded, '' for none. */
  | { page: 'museums'; locale: Locale; query: string }
  | { page: 'museum'; locale: Locale; slug: string }
  | { page: 'province'; locale: Locale; province: ProvinceSlug; query: string }
  | { page: 'search'; locale: Locale; query: string }
  | { page: 'map'; locale: Locale; query: string }
  | { page: 'legal'; locale: Locale; doc: LegalDoc }
  | { page: 'shell'; locale: Locale; app: ShellApp }
  | { page: 'not_found'; locale: Locale };

export type Page = Route['page'];
export type Resolved = { kind: 'route'; route: Route } | { kind: 'redirect'; location: string };

// The English segments are A§15.2's (owner, Q3).
const SEGMENT = {
  museums: { nl: 'musea', en: 'museums' },
  province: { nl: 'provincie', en: 'province' },
  map: { nl: 'kaart', en: 'map' },
  search: { nl: 'zoeken', en: 'search' },
} as const;

const LEGAL: Record<LegalDoc, Record<Locale, string>> = {
  privacy: { nl: 'privacy', en: 'privacy' },
  terms: { nl: 'voorwaarden', en: 'terms' },
  contact: { nl: 'contact', en: 'contact' },
  reviews: { nl: 'hoe-wij-reviews-controleren', en: 'how-we-check-reviews' },
};

const SHELL: Record<ShellApp, Record<Locale, string>> = {
  passport: { nl: 'paspoort', en: 'passport' },
  wishlist: { nl: 'verlanglijst', en: 'wishlist' },
  account: { nl: 'account', en: 'account' },
  signin: { nl: 'inloggen', en: 'sign-in' },
};

/**
 * The query parameters each page keeps, in this order (the API's list parameters, A§14). Any other
 * parameter is dropped, so a tracking parameter never turns a page into a 400. Values are the
 * API's to validate.
 */
const KEPT = {
  museums: ['q', 'province', 'municipality', 'category', 'mk', 'sort', 'limit', 'cursor'],
  // The map page shows the list's filters and the same list.
  map: ['q', 'province', 'municipality', 'category', 'mk', 'sort', 'limit', 'cursor'],
  province: ['cursor'],
  search: ['q', 'cursor'],
} as const;

/** The parameters of `GET /museums/points` (the contract's PointsQuery: any other one is a 400). */
const POINTS = ['q', 'province', 'municipality', 'category', 'mk'] as const;

function keep(search: string, names: readonly string[]): string {
  const given = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of names) {
    const value = given.get(name);
    // An empty field from a GET form without JavaScript means "no filter".
    if (value !== null && value.trim() !== '') kept.set(name, value);
  }
  return kept.toString();
}

const find = <K extends string>(table: Record<K, Record<Locale, string>>, locale: Locale, segment: string) =>
  (Object.keys(table) as K[]).find((key) => table[key][locale] === segment);

const isSlug = (s: string) => s.length <= SLUG_MAX && SLUG_RE.test(s);
const isProvince = (s: string): s is ProvinceSlug => Object.hasOwn(PROVINCE_SLUGS, s);

/** The locale of a path: EN for `/en` and everything under `/en/`, else NL. */
export function localeOf(path: string): Locale {
  const pathname = path.split('?', 1)[0] ?? '';
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'nl';
}

/** Resolves a request path (pathname plus query, no fragment). Never throws. */
export function routeOf(path: string): Resolved {
  const at = path.indexOf('?');
  const pathname = at === -1 ? path : path.slice(0, at);
  const search = at === -1 ? '' : path.slice(at);
  const locale = localeOf(pathname);
  const route = (r: Route): Resolved => ({ kind: 'route', route: r });
  if (pathname === '/en') return { kind: 'redirect', location: pathOf({ page: 'home', locale: 'en' }) };
  const rest = locale === 'en' ? pathname.slice(3) : pathname;
  if (rest.length > 1 && rest.endsWith('/')) {
    // `/musea/` → `/musea`. The Location is always our own canonical path, never request text, so
    // `//evil.example/` cannot become a protocol-relative redirect. A scan, not `/\/+$/`: that regex
    // is quadratic on `/////…/x/` and would stall the single-threaded `ssr` on one request.
    let end = pathname.length;
    while (end > 0 && pathname.charCodeAt(end - 1) === 0x2f) end--;
    const target = routeOf(`${pathname.slice(0, end)}${search}`);
    if (target.kind === 'route' && target.route.page !== 'not_found' && target.route.page !== 'home') {
      return { kind: 'redirect', location: pathOf(target.route) };
    }
    return route({ page: 'not_found', locale });
  }
  if (rest === '/') return route({ page: 'home', locale });
  if (!rest.startsWith('/')) return route({ page: 'not_found', locale });
  const parts = rest.slice(1).split('/');
  const [first = '', second, ...more] = parts;
  if (more.length > 0) return route({ page: 'not_found', locale });
  if (second === undefined) {
    if (first === SEGMENT.museums[locale]) return route({ page: 'museums', locale, query: keep(search, KEPT.museums) });
    if (first === SEGMENT.map[locale]) return route({ page: 'map', locale, query: keep(search, KEPT.map) });
    if (first === SEGMENT.search[locale]) return route({ page: 'search', locale, query: keep(search, KEPT.search) });
    const doc = find(LEGAL, locale, first);
    if (doc !== undefined) return route({ page: 'legal', locale, doc });
    const app = find(SHELL, locale, first);
    if (app !== undefined) return route({ page: 'shell', locale, app });
    return route({ page: 'not_found', locale });
  }
  if (first === SEGMENT.museums[locale] && isSlug(second)) return route({ page: 'museum', locale, slug: second });
  if (first === SEGMENT.province[locale] && isProvince(second)) {
    return route({ page: 'province', locale, province: second, query: keep(search, KEPT.province) });
  }
  return route({ page: 'not_found', locale });
}

/** The canonical path of a route; `routeOf(pathOf(r))` is `r` again. `not_found` maps to the home path. */
export function pathOf(route: Route): string {
  const { locale } = route;
  const prefix = locale === 'en' ? '/en' : '';
  const withQuery = (path: string, query: string) => (query === '' ? path : `${path}?${query}`);
  switch (route.page) {
    case 'home':
    case 'not_found':
      return `${prefix}/`;
    case 'museums':
      return withQuery(`${prefix}/${SEGMENT.museums[locale]}`, route.query);
    case 'museum':
      return `${prefix}/${SEGMENT.museums[locale]}/${route.slug}`;
    case 'province':
      return withQuery(`${prefix}/${SEGMENT.province[locale]}/${route.province}`, route.query);
    case 'search':
      return withQuery(`${prefix}/${SEGMENT.search[locale]}`, route.query);
    case 'map':
      return withQuery(`${prefix}/${SEGMENT.map[locale]}`, route.query);
    case 'legal':
      return `${prefix}/${LEGAL[route.doc][locale]}`;
    case 'shell':
      return `${prefix}/${SHELL[route.app][locale]}`;
  }
}

/** The same page in the other language. */
export const inLocale = (route: Route, locale: Locale): Route => ({ ...route, locale });

/** The `/api/v1` paths behind the pages; also the TanStack Query keys (A§15.1). */
export const apiPath = {
  provinces: '/api/v1/provinces',
  mkList: '/api/v1/mk-list',
  museum: (slug: string) => `/api/v1/museums/${slug}`,
  museums: (query: string) => (query === '' ? '/api/v1/museums' : `/api/v1/museums?${query}`),
  /** The map's points: the list's filters without the paging and sorting parameters. */
  points: (query: string) => {
    const points = keep(query === '' ? '' : `?${query}`, POINTS);
    return points === '' ? '/api/v1/museums/points' : `/api/v1/museums/points?${points}`;
  },
  near: (lat: string, lon: string) => `/api/v1/museums/near?lat=${lat}&lon=${lon}`,
};

/** The province list query: the province first, then the kept parameters. */
export function provinceQuery(route: Extract<Route, { page: 'province' }>): string {
  const query = new URLSearchParams({ province: PROVINCE_SLUGS[route.province] });
  for (const [name, value] of new URLSearchParams(route.query)) query.set(name, value);
  return query.toString();
}

/** What a page needs, in a fixed order: `mjk-state` holds these keys in this order. */
export function apiPathsOf(route: Route): readonly string[] {
  switch (route.page) {
    case 'home':
      return [apiPath.provinces, apiPath.mkList];
    case 'museums':
    case 'map':
      return [apiPath.museums(route.query), apiPath.provinces];
    case 'museum':
      return [apiPath.museum(route.slug)];
    case 'province':
      return [apiPath.provinces, apiPath.museums(provinceQuery(route))];
    case 'search':
      return new URLSearchParams(route.query).has('q') ? [apiPath.museums(route.query)] : [];
    default:
      return [];
  }
}
