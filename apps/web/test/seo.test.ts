import { AsyncLocalStorage } from 'node:async_hooks';
import type { MuseumDetail } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import { apiPath, type Locale, PROVINCE_SLUGS, pathOf, type Route } from '../src/lib/routes.ts';
import { headOf, jsonLdOf, type PageData } from '../src/lib/seo/head.tsx';
import { sitemapXml } from '../src/lib/seo/sitemap.ts';
import { overwriteServerAsyncLocalStorage } from '../src/paraglide/runtime.js';
import { REVIEW_ID, review, reviewList } from './review-fixture.ts';

const CONFIG = { brand: 'Musea Test', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' };

// The same locale mechanism as entry-server.tsx.
const renders = new AsyncLocalStorage<{ locale?: Locale }>();
overwriteServerAsyncLocalStorage(renders);
const inLocaleOf = <T>(locale: Locale, fn: () => T): T => renders.run({ locale }, fn);

const FULL: MuseumDetail = {
  id: '0194f2c0-0000-7000-8000-000000000001',
  slug: 'rijksmuseum',
  name: 'Rijksmuseum',
  name_en: 'Rijks Museum',
  place: 'Amsterdam',
  municipality_code: null,
  municipality_name: null,
  province_code: 'NL-NH',
  lat: 52.36,
  lon: 4.8852,
  categories: ['art'],
  museumkaart_status: 'participating',
  registered: true,
  closed_on: null,
  temp_closed: false,
  rating_count: 0,
  rating_mean: null,
  description_nl: 'nationaal museum',
  description_en: 'national museum',
  street: 'Museumstraat',
  house_number: '1',
  postcode: '1071 XX',
  website: 'https://www.example.org/',
  museumnl_url: null,
  mk_since: null,
  mk_until: null,
  mk_last_verified_at: null,
  admission_adult_cents: null,
  price_verified_at: null,
  photo_policy: 'unknown',
  temp_closed_until: null,
  image: null,
  mk_list: null,
  aspects: {
    collection: { mean: null, count: 0 },
    presentation: { mean: null, count: 0 },
    kid_friendly: { mean: null, count: 0 },
    accessibility: { mean: null, count: 0 },
    facilities: { mean: null, count: 0 },
    value_for_money: { mean: null, count: 0 },
  },
};

const SPARSE: MuseumDetail = {
  ...FULL,
  name_en: null,
  place: null,
  lat: null,
  lon: null,
  description_nl: null,
  description_en: null,
  street: null,
  house_number: null,
  postcode: null,
  website: null,
};

const PROVINCES = {
  items: Object.values(PROVINCE_SLUGS).map((code) => ({
    code,
    name_nl: `NL ${code}`,
    name_en: `EN ${code}`,
    museum_count: 1,
  })),
};

const dataFor = (museum: MuseumDetail): PageData =>
  new Map<string, unknown>([
    [apiPath.museum(museum.slug), museum],
    [apiPath.provinces, PROVINCES],
  ]);

const ROUTES = (locale: Locale): Route[] => [
  { page: 'home', locale },
  { page: 'museums', locale, query: '' },
  { page: 'museums', locale, query: 'province=NL-NH&limit=5' },
  { page: 'museum', locale, slug: 'rijksmuseum' },
  { page: 'province', locale, province: 'noord-holland', query: '' },
  { page: 'search', locale, query: 'q=rijks' },
  { page: 'map', locale, query: '' },
  { page: 'legal', locale, doc: 'privacy' },
  { page: 'shell', locale, app: 'passport' },
];

describe('headOf', () => {
  for (const locale of ['nl', 'en'] as const) {
    it.each(ROUTES(locale))(`$page in ${locale}: canonical, alternates, description`, (route) => {
      const head = inLocaleOf(locale, () => headOf(route, dataFor(FULL), CONFIG));
      expect(head.canonical).toBe(`https://mjk.test${pathOf(route)}`);
      expect(head.alternates).toEqual({
        nl: `https://mjk.test${pathOf({ ...route, locale: 'nl' })}`,
        en: `https://mjk.test${pathOf({ ...route, locale: 'en' })}`,
      });
      const described = ['home', 'museums', 'museum', 'province', 'map'].includes(route.page);
      expect(head.description === null).toBe(!described);
    });
  }

  it('describes a museum in its language, falls back to Dutch, then to name and place', () => {
    const route = (locale: Locale): Route => ({ page: 'museum', locale, slug: 'rijksmuseum' });
    const desc = (m: MuseumDetail, locale: Locale) =>
      inLocaleOf(locale, () => headOf(route(locale), dataFor(m), CONFIG).description);
    expect(desc(FULL, 'en')).toBe('national museum');
    expect(desc(FULL, 'nl')).toBe('nationaal museum');
    expect(desc({ ...FULL, description_en: null }, 'en')).toBe('nationaal museum');
    expect(desc({ ...SPARSE, place: 'Utrecht' }, 'nl')).toBe('Rijksmuseum in Utrecht: adres en Museumkaart');
    expect(desc({ ...SPARSE, place: 'Utrecht', name_en: 'Rijks' }, 'en')).toBe(
      'Rijks in Utrecht: address and Museumkaart',
    );
    expect(desc(SPARSE, 'nl')).toBe('Rijksmuseum: adres en Museumkaart');
  });
});

describe('the review pages heads (P3a)', () => {
  const reviewsRoute = (locale: Locale): Route => ({ page: 'museum-reviews', locale, slug: 'rijksmuseum' });
  const singleRoute = (locale: Locale): Route => ({ page: 'review', locale, id: REVIEW_ID });
  const reviewsData = new Map<string, unknown>([
    [apiPath.museum('rijksmuseum'), FULL],
    [apiPath.museumReviews('rijksmuseum'), reviewList()],
  ]);
  const singleData = new Map<string, unknown>([[apiPath.review(REVIEW_ID), review()]]);

  it("indexes a museum's reviews page, titled and described with the museum's name, canonical and hreflang", () => {
    const nl = inLocaleOf('nl', () => headOf(reviewsRoute('nl'), reviewsData, CONFIG));
    expect(nl.robots).toBeNull();
    expect(nl.title).toBe('Reviews van Rijksmuseum · Musea Test');
    expect(nl.description).toContain('Rijksmuseum');
    expect(nl.canonical).toBe('https://mjk.test/musea/rijksmuseum/reviews');
    expect(nl.alternates).toEqual({
      nl: 'https://mjk.test/musea/rijksmuseum/reviews',
      en: 'https://mjk.test/en/museums/rijksmuseum/reviews',
    });
    expect(inLocaleOf('en', () => headOf(reviewsRoute('en'), reviewsData, CONFIG)).title).toBe(
      'Reviews of Rijks Museum · Musea Test',
    );
  });

  it('keeps a single review out of the index but lets its links be followed (thin content naming a member)', () => {
    const head = inLocaleOf('nl', () => headOf(singleRoute('nl'), singleData, CONFIG));
    expect(head.robots).toBe('noindex, follow');
    expect(head.title).toBe('Review van Voorbeeldmuseum · Musea Test');
    expect(head.canonical).toBe(`https://mjk.test/reviews/${REVIEW_ID}`);
  });

  it('has no JSON-LD on either page', () => {
    expect(jsonLdOf(reviewsRoute('nl'), reviewsData, CONFIG)).toBeNull();
    expect(jsonLdOf(singleRoute('nl'), singleData, CONFIG)).toBeNull();
  });
});

describe('a profile head (Q2: noindex unless the member opted in)', () => {
  const route = (locale: Locale): Route => ({ page: 'profile', locale, handle: 'anna_b' });
  const profile = (over: Record<string, unknown> = {}) =>
    new Map<string, unknown>([
      [
        apiPath.user('anna_b'),
        {
          handle: 'anna_b',
          display_name: 'Anna <b>B</b>',
          member_since: '2026-11',
          indexable: false,
          progress: null,
          visits: null,
          wishlist: null,
          ...over,
        },
      ],
    ]);

  it('is noindex by default, with the display name in the title and the member month in the description', () => {
    const nl = inLocaleOf('nl', () => headOf(route('nl'), profile(), CONFIG));
    expect(nl.robots).toBe('noindex');
    expect(nl.title).toBe('Anna <b>B</b> · Musea Test');
    expect(nl.description).toBe('Het museumpaspoort van Anna <b>B</b>, lid sinds november 2026.');
    expect(nl.canonical).toBe('https://mjk.test/u/anna_b');
    const en = inLocaleOf('en', () => headOf(route('en'), profile(), CONFIG));
    expect(en.description).toBe("Anna <b>B</b>'s museum passport, a member since November 2026.");
    expect(en.canonical).toBe('https://mjk.test/en/u/anna_b');
  });

  it('has no robots tag once the member opted in', () => {
    expect(inLocaleOf('nl', () => headOf(route('nl'), profile({ indexable: true }), CONFIG)).robots).toBeNull();
  });
});

describe('jsonLdOf', () => {
  const route: Route = { page: 'museum', locale: 'en', slug: 'rijksmuseum' };

  it('is null for every page but a museum', () => {
    for (const r of ROUTES('nl').filter((r) => r.page !== 'museum')) {
      expect(jsonLdOf(r, dataFor(FULL), CONFIG)).toBeNull();
    }
  });

  it('describes a full museum', () => {
    expect(inLocaleOf('en', () => jsonLdOf(route, dataFor(FULL), CONFIG))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Museum',
      name: 'Rijks Museum',
      url: 'https://mjk.test/en/museums/rijksmuseum',
      description: 'national museum',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Museumstraat 1',
        postalCode: '1071 XX',
        addressLocality: 'Amsterdam',
        addressCountry: 'NL',
      },
      geo: { '@type': 'GeoCoordinates', latitude: 52.36, longitude: 4.8852 },
      sameAs: ['https://www.example.org/'],
    });
  });

  it('adds aggregateRating from one rating on, with the shown mean and nothing else (Q9)', () => {
    const rated = { ...FULL, rating_count: 12, rating_mean: 4.3 };
    const ld = inLocaleOf('en', () => jsonLdOf(route, dataFor(rated), CONFIG)) as Record<string, unknown>;
    expect(ld.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.3,
      ratingCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
    expect(Object.keys(ld).filter((k) => /review|rating/i.test(k))).toEqual(['aggregateRating']);
    const one = inLocaleOf('en', () => jsonLdOf(route, dataFor({ ...FULL, rating_count: 1, rating_mean: 5 }), CONFIG));
    expect(one).toHaveProperty('aggregateRating.ratingCount', 1);
    expect('aggregateRating' in (inLocaleOf('en', () => jsonLdOf(route, dataFor(FULL), CONFIG)) as object)).toBe(false);
  });

  it('omits what is unknown and holds no null', () => {
    const ld = inLocaleOf('nl', () => jsonLdOf({ ...route, locale: 'nl' }, dataFor(SPARSE), CONFIG)) as Record<
      string,
      unknown
    >;
    expect(ld.address).toEqual({ '@type': 'PostalAddress', addressCountry: 'NL' });
    expect('geo' in ld).toBe(false);
    expect('sameAs' in ld).toBe(false);
    expect(JSON.stringify(ld)).not.toContain('null');
  });

  it('keeps a hostile name verbatim in the object (the script writer escapes it)', () => {
    const name = '</script><img src=x onerror=alert(1)> & "q"';
    const ld = inLocaleOf('nl', () => jsonLdOf({ ...route, locale: 'nl' }, dataFor({ ...FULL, name }), CONFIG)) as {
      name: string;
    };
    expect(ld.name).toBe(name);
  });
});

describe('sitemapXml', () => {
  const slugs = ['a-museum', 'b-museum', 'c-museum'];
  const locs = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1] as string);

  it('lists both languages of the home page, the list, 12 provinces and every museum', () => {
    const urls = locs(sitemapXml(slugs, [], CONFIG));
    expect(urls).toHaveLength(2 * (1 + 1 + 12 + slugs.length));
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain('https://mjk.test/');
    expect(urls).toContain('https://mjk.test/en/');
    expect(urls).toContain('https://mjk.test/musea');
    expect(urls).toContain('https://mjk.test/en/museums');
    expect(urls).toContain('https://mjk.test/provincie/fryslan');
    expect(urls).toContain('https://mjk.test/en/province/zuid-holland');
    expect(urls).toContain('https://mjk.test/musea/b-museum');
    expect(urls).toContain('https://mjk.test/en/museums/b-museum');
    expect(urls.some((u) => /kaart|map|zoeken|search|privacy|paspoort|passport/.test(u))).toBe(false);
  });

  it('is in a stable order: NL then EN, each home, list, provinces, museums', () => {
    const urls = locs(sitemapXml(slugs, [], CONFIG));
    expect(urls.slice(0, 3)).toEqual([
      'https://mjk.test/',
      'https://mjk.test/musea',
      'https://mjk.test/provincie/drenthe',
    ]);
    expect(urls.slice(14, 17)).toEqual([
      'https://mjk.test/musea/a-museum',
      'https://mjk.test/musea/b-museum',
      'https://mjk.test/musea/c-museum',
    ]);
    expect(urls[17]).toBe('https://mjk.test/en/');
    expect(sitemapXml(slugs, [], CONFIG)).toBe(sitemapXml(slugs, [], CONFIG));
  });

  it('lists the opted-in profiles after the museums, in both languages', () => {
    const urls = locs(sitemapXml(slugs, ['anna_b', 'bob'], CONFIG));
    expect(urls).toHaveLength(2 * (1 + 1 + 12 + slugs.length + 2));
    expect(urls.slice(17, 19)).toEqual(['https://mjk.test/u/anna_b', 'https://mjk.test/u/bob']);
    expect(urls).toContain('https://mjk.test/en/u/anna_b');
    expect(urls).toContain('https://mjk.test/en/u/bob');
  });

  it('lists the review pages of the rated museums after the museums, in both languages', () => {
    const urls = locs(sitemapXml(slugs, ['anna_b'], CONFIG, ['b-museum']));
    expect(urls).toHaveLength(2 * (1 + 1 + 12 + slugs.length + 1 + 1));
    expect(urls.slice(17, 19)).toEqual(['https://mjk.test/musea/b-museum/reviews', 'https://mjk.test/u/anna_b']);
    expect(urls).toContain('https://mjk.test/en/museums/b-museum/reviews');
    expect(urls.some((u) => u.includes('/reviews/'))).toBe(false); // no single review page
    expect(locs(sitemapXml(slugs, [], CONFIG)).some((u) => u.endsWith('/reviews'))).toBe(false);
  });

  it('escapes XML metacharacters', () => {
    const xml = sitemapXml(['a'], [], { brand: 'x', domain: `h&<>"'`, controller: 'x', contactEmail: 'x@x.nl' });
    expect(xml).toContain('<loc>https://h&amp;&lt;&gt;&quot;&apos;/</loc>');
  });
});
