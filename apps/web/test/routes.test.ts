import { PROVINCE_CODES } from '@mjk/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  apiPathsOf,
  inLocale,
  localeOf,
  PROVINCE_SLUGS,
  pathOf,
  type Resolved,
  type Route,
  routeOf,
} from '../src/lib/routes.ts';

/** Omit over each member of the union, not over the union. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type WithoutLocale = DistOmit<Route, 'locale'>;

const route = (path: string): Route => {
  const r = routeOf(path);
  if (r.kind !== 'route') throw new Error(`${path} redirects`);
  return r.route;
};

describe('routeOf: the A§15.2 table', () => {
  const pairs: [string, string, WithoutLocale][] = [
    ['/', '/en/', { page: 'home' }],
    ['/musea', '/en/museums', { page: 'museums', query: '' }],
    [
      '/musea/rijksmuseum-amsterdam',
      '/en/museums/rijksmuseum-amsterdam',
      { page: 'museum', slug: 'rijksmuseum-amsterdam' },
    ],
    [
      '/provincie/noord-holland',
      '/en/province/noord-holland',
      { page: 'province', province: 'noord-holland', query: '' },
    ],
    ['/provincie/fryslan', '/en/province/fryslan', { page: 'province', province: 'fryslan', query: '' }],
    ['/kaart', '/en/map', { page: 'map' }],
    ['/zoeken', '/en/search', { page: 'search', query: '' }],
    ['/privacy', '/en/privacy', { page: 'legal', doc: 'privacy' }],
    ['/voorwaarden', '/en/terms', { page: 'legal', doc: 'terms' }],
    ['/contact', '/en/contact', { page: 'legal', doc: 'contact' }],
    ['/hoe-wij-reviews-controleren', '/en/how-we-check-reviews', { page: 'legal', doc: 'reviews' }],
    ['/paspoort', '/en/passport', { page: 'shell', app: 'passport' }],
    ['/verlanglijst', '/en/wishlist', { page: 'shell', app: 'wishlist' }],
    ['/account', '/en/account', { page: 'shell', app: 'account' }],
    ['/inloggen', '/en/sign-in', { page: 'shell', app: 'signin' }],
  ];

  it.each(pairs)('%s and %s', (nl, en, expected) => {
    expect(route(nl)).toEqual({ ...expected, locale: 'nl' });
    expect(route(en)).toEqual({ ...expected, locale: 'en' });
    expect(pathOf(route(nl))).toBe(nl);
    expect(pathOf(route(en))).toBe(en);
    expect(pathOf(inLocale(route(nl), 'en'))).toBe(en);
  });

  it.each([
    '/museums',
    '/en/musea',
    '/musea/Rijksmuseum',
    '/musea/a--b',
    '/musea/x/reviews',
    '/provincie/north-holland',
    '/en/province/friesland',
    '/u/someone',
    '/melden',
    '/enx',
    '//evil.example',
    'musea',
    '',
  ])('%s is not found', (path) => {
    expect(route(path).page).toBe('not_found');
  });

  it('keeps the slug cap of the API', () => {
    expect(route(`/musea/${'a'.repeat(120)}`).page).toBe('museum');
    expect(route(`/musea/${'a'.repeat(121)}`).page).toBe('not_found');
  });

  it.each<[string, Resolved]>([
    ['/en', { kind: 'redirect', location: '/en/' }],
    ['/en?x=1', { kind: 'redirect', location: '/en/' }],
    ['/musea/', { kind: 'redirect', location: '/musea' }],
    ['/musea/?province=NL-NH&utm=x', { kind: 'redirect', location: '/musea?province=NL-NH' }],
    ['/en/museums/rijksmuseum//', { kind: 'redirect', location: '/en/museums/rijksmuseum' }],
  ])('%s redirects to the canonical path', (path, expected) => {
    expect(routeOf(path)).toEqual(expected);
  });

  it.each(['//evil.example/', '/\\evil.example/', '/en//', '//', '/nope/'])(
    '%s never redirects (no open redirect)',
    (path) => {
      expect(routeOf(path)).toEqual({ kind: 'route', route: { page: 'not_found', locale: localeOf(path) } });
    },
  );

  // A request line may be ~16 KB (Node's header cap, Cloudflare's URL limit). `/\/+$/` took ~200 ms
  // on the first shape: routeOf runs on the single `ssr` event loop, so every shape stays linear.
  const N = 16_000;
  it.each<[string, string, Resolved]>([
    ['slashes, then x/', `${'/'.repeat(N)}x/`, { kind: 'route', route: { page: 'not_found', locale: 'nl' } }],
    ['en, slashes, then x/', `/en${'/'.repeat(N)}x/`, { kind: 'route', route: { page: 'not_found', locale: 'en' } }],
    ['only slashes', '/'.repeat(N), { kind: 'route', route: { page: 'not_found', locale: 'nl' } }],
    [
      'a long slug-like segment',
      `/musea/${'a-'.repeat(N / 2)}!/`,
      { kind: 'route', route: { page: 'not_found', locale: 'nl' } },
    ],
    ['many segments', `/musea${'/a'.repeat(N / 2)}/`, { kind: 'route', route: { page: 'not_found', locale: 'nl' } }],
    ['a long query', `/musea/?${'q=&'.repeat(N / 3)}`, { kind: 'redirect', location: '/musea' }],
  ])('a hostile 16 KB path (%s) resolves in linear time', (_n, path, expected) => {
    const start = performance.now();
    expect(routeOf(path)).toEqual(expected);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('query parameters', () => {
  it('keeps the list parameters in a fixed order and drops the rest', () => {
    expect(route('/musea?utm_source=x&mk=participating&q=van+gogh&province=NL-NH&q=second')).toEqual({
      page: 'museums',
      locale: 'nl',
      query: 'q=van+gogh&province=NL-NH&mk=participating',
    });
  });

  it('drops empty form fields', () => {
    expect(route('/musea?q=&province=&category=art&mk=')).toMatchObject({ query: 'category=art' });
    expect(route('/zoeken?q=%20%20')).toMatchObject({ query: '' });
  });

  it('keeps only the cursor on a province page and q and the cursor on search', () => {
    expect(route('/provincie/utrecht?cursor=abc&q=x')).toMatchObject({ query: 'cursor=abc' });
    expect(route('/zoeken?q=rijks&province=NL-NH&cursor=c')).toMatchObject({ query: 'q=rijks&cursor=c' });
  });
});

describe('apiPathsOf', () => {
  it.each<[string, string[]]>([
    ['/', ['/api/v1/provinces', '/api/v1/mk-list']],
    ['/musea', ['/api/v1/museums', '/api/v1/provinces']],
    ['/musea?province=NL-NH&q=x', ['/api/v1/museums?q=x&province=NL-NH', '/api/v1/provinces']],
    ['/en/museums/kroller-muller-museum-otterlo', ['/api/v1/museums/kroller-muller-museum-otterlo']],
    ['/provincie/noord-holland?cursor=abc', ['/api/v1/provinces', '/api/v1/museums?province=NL-NH&cursor=abc']],
    ['/zoeken', []],
    ['/zoeken?q=rijks', ['/api/v1/museums?q=rijks']],
    ['/kaart', []],
    ['/privacy', []],
    ['/inloggen', []],
  ])('%s needs %j', (path, expected) => {
    expect(apiPathsOf(route(path))).toEqual(expected);
  });
});

describe('province slugs', () => {
  it('name all twelve provinces once', () => {
    expect(Object.values(PROVINCE_SLUGS).toSorted()).toEqual([...PROVINCE_CODES].toSorted());
  });
});

describe('properties', () => {
  it('never throws, and a route survives its own canonical path', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (pathname, search) => {
        const path = `/${pathname}${search === '' ? '' : `?${search}`}`;
        const resolved = routeOf(path);
        if (resolved.kind === 'redirect') {
          expect(resolved.location.startsWith('/')).toBe(true);
          expect(resolved.location.startsWith('//')).toBe(false);
          return;
        }
        if (resolved.route.page === 'not_found') return;
        expect(routeOf(pathOf(resolved.route))).toEqual(resolved);
        for (const locale of ['nl', 'en'] as const) {
          const other = inLocale(resolved.route, locale);
          expect(routeOf(pathOf(other))).toEqual({ kind: 'route', route: other });
        }
      }),
      { numRuns: 2000 },
    );
  });
});
