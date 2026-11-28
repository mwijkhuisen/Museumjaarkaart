import {
  MkList,
  type MuseumDetail,
  MuseumDetail as MuseumDetailSchema,
  type MuseumList,
  MuseumList as MuseumListSchema,
  PROVINCE_CODES,
  Provinces,
  type ReviewList,
  UserProfile,
} from '@mjk/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/lib/api.ts';
import { apiPath, apiPathsOf, type Route, routeOf } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';
import { REVIEW_ID, review, reviewList } from './review-fixture.ts';

const provinces = Provinces.parse({
  items: PROVINCE_CODES.map((code, i) => ({
    code,
    name_nl: `Provincie ${code}`,
    name_en: `Province ${code}`,
    museum_count: i + 1,
  })),
});
const mkList = MkList.parse({ list: { published_on: '2026-11-05', n: 512 } });

const item = (over: Record<string, unknown> = {}) => ({
  id: '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11',
  slug: 'voorbeeld-museum',
  name: 'Voorbeeldmuseum',
  name_en: 'Example Museum',
  place: 'Haarlem',
  municipality_code: 'GM0392',
  municipality_name: 'Haarlem',
  province_code: 'NL-NH',
  lat: 52.38,
  lon: 4.63,
  categories: ['art', 'history'],
  museumkaart_status: 'participating',
  registered: true,
  closed_on: null,
  temp_closed: false,
  rating_count: 0,
  rating_mean: null,
  ...over,
});

const detail = (over: Record<string, unknown> = {}): MuseumDetail =>
  MuseumDetailSchema.parse({
    ...item(),
    description_nl: 'Een Nederlandse beschrijving.',
    description_en: null,
    street: 'Kerkstraat',
    house_number: '12',
    postcode: '2011 AB',
    website: 'https://example.org/',
    museumnl_url: 'https://www.museum.nl/nl/voorbeeld',
    mk_since: null,
    mk_until: null,
    mk_last_verified_at: null,
    admission_adult_cents: null,
    price_verified_at: null,
    photo_policy: 'unknown',
    temp_closed_until: null,
    image: null,
    mk_list: { published_on: '2026-11-05', n: 512, member: true },
    aspects: {
      collection: { mean: null, count: 0 },
      presentation: { mean: null, count: 0 },
      kid_friendly: { mean: null, count: 0 },
      accessibility: { mean: null, count: 0 },
      facilities: { mean: null, count: 0 },
      value_for_money: { mean: null, count: 0 },
    },
    ...over,
  });

const list = (): MuseumList =>
  MuseumListSchema.parse({
    items: [
      item(),
      item({ id: '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a12', slug: 'tweede', name: 'Tweede', closed_on: '2026-03-01' }),
    ],
    next_cursor: 'abc123',
    total: 2,
  });

/** The cache keys a route needs, seeded with fixtures (the same data on the server and in the browser). */
function seed(route: Route, museum: MuseumDetail, profile: unknown, userReviews: ReviewList): Map<string, unknown> {
  const data = new Map<string, unknown>();
  for (const path of apiPathsOf(route)) {
    if (path === apiPath.provinces) data.set(path, provinces);
    else if (path === apiPath.mkList) data.set(path, mkList);
    else if (path.endsWith('/reviews')) data.set(path, path.startsWith('/api/v1/users/') ? userReviews : reviewList());
    else if (path.startsWith('/api/v1/reviews/')) data.set(path, review());
    else if (path.startsWith('/api/v1/museums/')) data.set(path, museum);
    else if (path.startsWith('/api/v1/users/')) data.set(path, profile);
    else data.set(path, list());
  }
  return data;
}

function render(
  path: string,
  museum: MuseumDetail = detail(),
  profile: unknown = null,
  userReviews: ReviewList = reviewList([]),
): string {
  const resolved = routeOf(path);
  if (resolved.kind !== 'route') throw new Error('not a route');
  setLocale(resolved.route.locale, { reload: false });
  const queryClient = createQueryClient();
  for (const [key, value] of seed(resolved.route, museum, profile, userReviews)) queryClient.setQueryData([key], value);
  return renderToStaticMarkup(
    <App
      path={path}
      queryClient={queryClient}
      config={{
        brand: 'Testmerk',
        controller: 'Test Beheerder',
        contactEmail: 'info@mjk.test',
        media: 'https://media.mjk.test',
      }}
    />,
  );
}

const PATHS = [
  '/',
  '/musea',
  '/musea/voorbeeld-museum',
  '/musea/voorbeeld-museum/reviews',
  `/reviews/${REVIEW_ID}`,
  '/provincie/noord-holland',
  '/zoeken',
  '/zoeken?q=haarlem',
  '/kaart',
  '/privacy',
  '/voorwaarden',
  '/contact',
  '/hoe-wij-reviews-controleren',
  '/paspoort',
  '/inloggen',
  '/account',
  '/bestaat-niet',
];
const EN_PATHS = [
  '/en/',
  '/en/museums',
  '/en/museums/voorbeeld-museum',
  '/en/museums/voorbeeld-museum/reviews',
  `/en/reviews/${REVIEW_ID}`,
  '/en/province/noord-holland',
  '/en/search',
  '/en/search?q=haarlem',
  '/en/map',
  '/en/privacy',
  '/en/terms',
  '/en/contact',
  '/en/how-we-check-reviews',
  '/en/passport',
  '/en/sign-in',
  '/en/account',
  '/en/does-not-exist',
];

describe.each([
  { locale: 'nl', paths: PATHS, other: '/en/', contact: '/contact', line: 'Niet verbonden aan de Museumvereniging' },
  {
    locale: 'en',
    paths: EN_PATHS,
    other: '/',
    contact: '/en/contact',
    line: 'Not affiliated with the Museumvereniging',
  },
])('every page in $locale', ({ paths, contact, line }) => {
  it.each(paths)('%s has the frame and no inline style', (path) => {
    const html = render(path);
    expect(html).not.toContain('style=');
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html).toContain('<main id="main" tabindex="-1" class="page">');
    expect(html.match(/Testmerk/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain(line);
    expect(html).toMatch(/(garantie|without guarantee)\./);
    expect(html).toContain(`href="${contact}"`);
  });
});

describe('the other-language link', () => {
  it.each([
    ['/', '/en/', 'English', 'en'],
    ['/musea/voorbeeld-museum', '/en/museums/voorbeeld-museum', 'English', 'en'],
    ['/bestaat-niet', '/en/', 'English', 'en'],
    ['/en/', '/', 'Nederlands', 'nl'],
    ['/en/province/noord-holland', '/provincie/noord-holland', 'Nederlands', 'nl'],
    ['/en/does-not-exist', '/', 'Nederlands', 'nl'],
  ])('%s links to %s', (path, href, text, lang) => {
    const html = render(path);
    const anchor = `<a href="${href}" hrefLang="${lang}" lang="${lang}">`;
    expect(html.split(anchor)).toHaveLength(3); // header and footer
    expect(html).toContain(text);
  });
});

describe('the museum page', () => {
  it('shows the name, address, status with list date and the categories (NL)', () => {
    const html = render('/musea/voorbeeld-museum');
    expect(html).toContain('<h1>Voorbeeldmuseum</h1>');
    expect(html).toContain('Kerkstraat 12');
    expect(html).toContain('2011 AB Haarlem');
    expect(html).toContain('badge badge--participating');
    expect(html).toContain('Museumkaart geldig');
    expect(html).toContain('lijst november 2026');
    expect(html).toContain('Kunst, Geschiedenis');
    expect(html).toContain('Geregistreerd museum');
    expect(html).toContain('Een Nederlandse beschrijving.');
    expect(html).toContain('Noord-Holland');
    expect(html).toContain('href="https://example.org/" rel="noopener noreferrer"');
    expect(html).toContain('Bekijk op de kaart');
  });

  it('uses the English name, labels and the Dutch description as a fallback (EN)', () => {
    const html = render('/en/museums/voorbeeld-museum');
    expect(html).toContain('<h1>Example Museum</h1>');
    expect(html).toContain('Museumkaart valid');
    expect(html).toContain('list November 2026');
    expect(html).toContain('Art, History');
    expect(html).toContain('Een Nederlandse beschrijving.');
  });

  it('shows the closed and temporarily closed variants from the data, not the clock', () => {
    expect(render('/musea/voorbeeld-museum', detail({ closed_on: '2025-12-31' }))).toContain(
      'Gesloten per 31 december 2025',
    );
    expect(render('/musea/voorbeeld-museum', detail({ temp_closed: true, temp_closed_until: '2027-02-01' }))).toContain(
      'Tijdelijk gesloten tot 1 februari 2027',
    );
    expect(render('/musea/voorbeeld-museum', detail({ temp_closed: true }))).toContain(
      'Tijdelijk gesloten tot nader bericht',
    );
    expect(render('/en/museums/voorbeeld-museum', detail({ temp_closed: true }))).toContain(
      'Temporarily closed until further notice',
    );
    expect(render('/musea/voorbeeld-museum')).not.toContain('gesloten');
  });

  describe('the Commons image (ADR-0018)', () => {
    const KEY = 'ab'.repeat(16);
    const image = (over: Record<string, unknown> = {}) => ({
      public_key: KEY,
      widths: [640, 1280],
      width: 1920,
      height: 1280,
      licence: 'cc-by-sa-4.0',
      attribution: 'Jane Doe',
      file: 'Het Muzeum (1).jpg',
      ...over,
    });

    it('shows our own variants, the credit as text, the deed, the file page and the edit note (NL and EN)', () => {
      const nl = render('/musea/voorbeeld-museum', detail({ image: image() }));
      expect(nl).toContain(`<source type="image/avif" srcSet="https://media.mjk.test/p/${KEY}/640.avif 640w, `);
      expect(nl).toContain('<figcaption class="muted">Foto: Jane Doe · ');
      expect(nl).toContain(
        '<a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener noreferrer">CC BY-SA 4.0</a>',
      );
      expect(nl).toContain('href="https://commons.wikimedia.org/wiki/File:Het_Muzeum_(1).jpg"');
      expect(nl).toContain('bewerkt (verkleind)');
      const en = render('/en/museums/voorbeeld-museum', detail({ image: image() }));
      expect(en).toContain('Photo: Jane Doe');
      expect(en).toContain('File on Wikimedia Commons');
      expect(en).toContain('resized');
    });

    it('requests nothing from a Wikimedia host: no src or srcset names one', () => {
      const html = render('/musea/voorbeeld-museum', detail({ image: image() }));
      const urls = [...html.matchAll(/(?:src|srcSet)="([^"]*)"/g)].map((x) => x[1] as string);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.join(' ')).not.toMatch(/wikimedia|wikipedia/);
      expect(urls.join(' ')).toContain('https://media.mjk.test/p/');
    });

    it('escapes a hostile credit and shows a public-domain file with no credit', () => {
      const html = render(
        '/musea/voorbeeld-museum',
        detail({ image: image({ attribution: '<script>alert(1)</script><img src=x onerror=alert(2)>' }) }),
      );
      expect(html).toContain('Foto: &lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;');
      expect(html).not.toMatch(/<script|<img src=x/);
      const pd = render('/musea/voorbeeld-museum', detail({ image: image({ licence: 'pd', attribution: null }) }));
      expect(pd).not.toContain('Foto:');
      expect(pd).toContain('Publiek domein');
    });

    it('shows no figure without an image', () => {
      expect(render('/musea/voorbeeld-museum')).not.toContain('<figure');
    });
  });

  it('shows an unknown value as a dash with its reason', () => {
    const html = render(
      '/musea/voorbeeld-museum',
      detail({ website: null, museumnl_url: null, street: null, house_number: null, postcode: null, place: null }),
    );
    expect(html).not.toContain('example.org');
    expect(html.match(/— <span class="muted">niet bekend in de open bronnen<\/span>/g)).toHaveLength(3);
    expect(render('/en/museums/voorbeeld-museum', detail({ website: null }))).toContain(
      '— <span class="muted">not known in the open sources</span>',
    );
  });

  it('shows the other statuses with their own word', () => {
    expect(render('/musea/voorbeeld-museum', detail({ museumkaart_status: 'left', mk_list: null }))).toContain(
      'badge--left',
    );
    const unknown = render('/musea/voorbeeld-museum', detail({ museumkaart_status: 'unknown', mk_list: null }));
    expect(unknown).toContain('Museumkaart onbekend');
    expect(unknown).not.toContain('lijst november');
  });

  it('escapes a hostile name', () => {
    const name = '</script><script>alert(1)</script>';
    const html = render('/musea/voorbeeld-museum', detail({ name, name_en: null }));
    expect(html).toContain('&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('</script><script>');
  });
});

describe('the museum page scores and the review pages (P3a)', () => {
  const rated = (over: Record<string, unknown> = {}) =>
    detail({
      rating_count: 12,
      rating_mean: 4.3,
      aspects: { ...detail().aspects, collection: { mean: 4.5, count: 6 } },
      ...over,
    });

  it('shows the score in the fold with the reviews link, or "Nog geen beoordelingen"', () => {
    const html = render('/musea/voorbeeld-museum', rated());
    expect(html).toContain('<h2 id="museum-score">Beoordelingen</h2>');
    expect(html).toContain('4,3 van 5');
    expect(html).toContain('href="/musea/voorbeeld-museum/reviews"');
    expect(html).toContain('href="/hoe-wij-reviews-controleren"');
    expect(render('/en/museums/voorbeeld-museum', rated())).toContain('4.3 out of 5');
    const none = render('/musea/voorbeeld-museum');
    expect(none).toContain('Nog geen beoordelingen');
    expect(none).not.toContain('/musea/voorbeeld-museum/reviews');
  });

  it('shows the card score on a list card with a rating, and nothing on one without', () => {
    // The list fixture's museums have no rating: no card score at all.
    expect(render('/musea')).not.toContain('card-score');
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      [apiPath.museums('')],
      MuseumListSchema.parse({ items: [item({ rating_count: 3, rating_mean: 4 })], next_cursor: null, total: 1 }),
    );
    queryClient.setQueryData([apiPath.provinces], provinces);
    setLocale('nl', { reload: false });
    const html = renderToStaticMarkup(
      <App
        path="/musea"
        queryClient={queryClient}
        config={{ brand: 'T', controller: 'T', contactEmail: 'a@b.nl', media: 'https://media.mjk.test' }}
      />,
    );
    expect(html).toContain('class="card-score cluster"');
    expect(html).toContain('<strong>4,0</strong>');
    expect(html).toContain('aria-label="Hoe wij reviews controleren"');
  });

  it("shows a museum's reviews under its name, a closed museum's too, and one review with a link back", () => {
    const closed = render('/musea/voorbeeld-museum/reviews', rated({ closed_on: '2025-12-31' }));
    expect(closed).toContain('<h1><a href="/musea/voorbeeld-museum">Voorbeeldmuseum</a></h1>');
    expect(closed).toContain('Gesloten per 31 december 2025');
    expect(closed).toContain('Mooie collectie.');
    expect(closed).toContain('Bezocht op 12 september 2026');
    const single = render(`/en/reviews/${REVIEW_ID}`);
    expect(single).toContain('<h1>Review of Example Museum</h1>');
    expect(single).toContain('href="/en/museums/voorbeeld-museum/reviews"');
    expect(single).toContain('Mooie collectie.');
  });
});

describe('the list page', () => {
  it('pre-fills the filters from the query and links the next page', () => {
    const html = render('/musea?q=haarlem&province=NL-NH&category=art&mk=participating');
    expect(html).toContain('class="filters"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="haarlem"');
    expect(html).toContain('<option value="NL-NH" selected="">');
    expect(html).toContain('<option value="art" selected="">');
    expect(html).toContain('<input type="checkbox" name="mk" checked="" value="participating"/>');
    expect(html).toContain(
      'href="/musea?q=haarlem&amp;province=NL-NH&amp;category=art&amp;mk=participating&amp;cursor=abc123"',
    );
    expect(html).toContain('Aantal musea: 2');
  });

  it('offers the rating filters as a GET form that works without JavaScript, pre-filled from the query', () => {
    const html = render('/musea?min_rating=4&kid_friendly=true');
    expect(html).toContain('<select id="f-min-rating" name="min_rating">');
    expect(html).toContain('<option value="4" selected="">4+</option>');
    expect(html).toContain('<option value="5">5</option>');
    expect(html).toContain('<input type="checkbox" name="kid_friendly" checked="" value="true"/>');
    expect(html).toContain('Minimale beoordeling (sterren)');
    expect(html).toContain('Kindvriendelijk (4 of hoger)');
    const plain = render('/musea');
    expect(plain).not.toContain('<input type="checkbox" name="kid_friendly" checked=""');
    expect(plain).not.toMatch(/<option value="[1-5]" selected/);
    // The map page shows the same filters.
    expect(render('/en/map?min_rating=2')).toContain('<option value="2" selected="">2+</option>');
  });

  it('leaves the filters empty without a query and shows an empty state', () => {
    const html = render('/musea');
    expect(html).toContain('<option value="" selected="">');
    expect(html).not.toMatch(/<option value="[^"]+" selected/);
    expect(html).not.toContain('checked=""');
    const empty = MuseumListSchema.parse({ items: [], next_cursor: null, total: 0 });
    const resolved = routeOf('/musea');
    if (resolved.kind !== 'route') throw new Error('route');
    const queryClient = createQueryClient();
    queryClient.setQueryData([apiPath.museums('')], empty);
    queryClient.setQueryData([apiPath.provinces], provinces);
    setLocale('nl', { reload: false });
    expect(
      renderToStaticMarkup(
        <App
          path="/musea"
          queryClient={queryClient}
          config={{
            brand: 'Testmerk',
            controller: 'Test Beheerder',
            contactEmail: 'info@mjk.test',
            media: 'https://media.mjk.test',
          }}
        />,
      ),
    ).toContain('Geen musea gevonden');
  });

  it('shows the Museumkaart list line on the home page', () => {
    expect(render('/')).toContain('Museumkaart-lijst van november 2026: 512 musea');
    expect(render('/en/')).toContain('Museumkaart list of November 2026: 512 museums');
  });
});

describe('the map page (server-rendered: the filters and the list, never the map)', () => {
  it.each([
    [
      'nl',
      '/kaart?province=NL-NH&mk=participating',
      '<h1>Kaart</h1>',
      'Dezelfde musea als lijst',
      'Aantal musea: 2',
      '/kaart',
      'Voorbeeldmuseum',
    ],
    [
      'en',
      '/en/map?province=NL-NH&mk=participating',
      '<h1>Map</h1>',
      'The same museums as a list',
      'Number of museums: 2',
      '/en/map',
      'Example Museum',
    ],
  ])(
    '%s: filters pre-filled, the list and the pager stay on the map page',
    (_l, path, h1, listHeading, total, action, name) => {
      const html = render(path);
      expect(html).toContain(h1);
      expect(html).toContain(`<form class="filters" action="${action}" method="get">`);
      expect(html).toContain('<option value="NL-NH" selected="">');
      expect(html).toContain('<input type="checkbox" name="mk" checked="" value="participating"/>');
      expect(html).toContain(listHeading);
      expect(html).toContain(total);
      expect(html).toContain('class="card-list"');
      expect(html).toContain(name);
      expect(html).toContain(`href="${action}?province=NL-NH&amp;mk=participating&amp;cursor=abc123"`);
    },
  );

  it('holds no map, no near-me button and no map element before hydration, and a note for no-JavaScript browsers', () => {
    for (const path of ['/kaart', '/en/map']) {
      const html = render(path);
      expect(html).not.toMatch(/maplibre/i);
      expect(html).not.toContain('museum-map');
      expect(html).not.toContain('near-me');
      expect(html).not.toContain('<canvas');
    }
    expect(render('/kaart')).toContain('<noscript><p>De kaart heeft JavaScript nodig.');
    expect(render('/en/map')).toContain('<noscript><p>The map needs JavaScript.');
  });
});

describe('the profile page', () => {
  const pm = (slug: string, over: Record<string, unknown> = {}) => ({
    slug,
    name: `Museum ${slug}`,
    name_en: null,
    place: 'Haarlem',
    ...over,
  });
  const profile = (over: Record<string, unknown> = {}) =>
    UserProfile.parse({
      handle: 'anna_b',
      display_name: 'Anna de Vries',
      member_since: '2026-03',
      indexable: false,
      progress: {
        list: {
          published_on: '2026-11-05',
          n: 512,
          visited: 37,
          provinces: [
            { code: 'NL-NH', n: 80, visited: 9 },
            { code: null, n: 3, visited: 0 },
          ],
        },
        all_time: 41,
        years: [{ year: 2026, museums: 12 }],
      },
      visits: {
        items: [
          { museum: pm('een'), visited_month: '2026-11', visits: 1 },
          { museum: pm('twee', { name_en: 'Two' }), visited_month: '2026-11', visits: 3 },
          { museum: pm('drie', { place: null }), visited_month: null, visits: 1 },
        ],
        next: 'abc',
      },
      wishlist: { items: [{ museum: pm('vier') }], next: null },
      ...over,
    });

  it('shows the name, initials, member month, progress with its list date, the log by month and the wishlist (NL)', () => {
    const html = render('/u/anna_b', detail(), profile());
    expect(html).toContain('<h1>Anna de Vries</h1>');
    expect(html).toContain('<span class="avatar" aria-hidden="true">AD</span>');
    expect(html).toContain('Lid sinds maart 2026');
    expect(html).toContain('37 van 512 · lijst november 2026');
    expect(html).toContain('Noord-Holland: 9 van 80');
    expect(html).toContain('Provincie onbekend: 0 van 3');
    expect(html).toContain('Ooit bezocht: 41');
    expect(html).toContain('<h3>november 2026</h3>');
    expect(html).toContain('<h3>Eerder, datum onbekend</h3>');
    expect(html).toContain('href="/musea/twee"');
    expect(html).toContain('3 keer');
    expect(html).toContain('Verlanglijst');
    expect(html).toContain('href="/musea/vier"');
    expect(html.match(/>Meer</g)).toHaveLength(1); // the log has a next page, the wishlist has not
    expect(html).not.toContain('style=');
  });

  it('uses English names and labels (EN)', () => {
    const html = render('/en/u/anna_b', detail(), profile());
    expect(html).toContain('Member since March 2026');
    expect(html).toContain('37 of 512 · list November 2026');
    expect(html).toContain('href="/en/museums/twee"');
    expect(html).toContain('>Two<');
    expect(html).toContain('Earlier, date unknown');
  });

  it('leaves a private list out and says so when nothing is shared', () => {
    const only = render('/u/anna_b', detail(), profile({ visits: null, wishlist: null }));
    expect(only).not.toContain('Bezochte musea');
    expect(only).not.toContain('Verlanglijst');
    expect(only).toContain('Voortgang');
    const none = render('/u/anna_b', detail(), profile({ progress: null, visits: null, wishlist: null }));
    expect(none).toContain('Anna de Vries deelt nog niets.');
    expect(none).not.toContain('Voortgang');
  });

  it("lists the member's reviews with the museum named, hides the section when there are none, and counts as sharing", () => {
    const withReview = render(
      '/u/anna_b',
      detail(),
      profile({ progress: null, visits: null, wishlist: null }),
      reviewList([review({ body: 'Mooi <b>huis</b>' })], 'abc'),
    );
    expect(withReview).toContain('<h2 id="profile-reviews">Reviews</h2>');
    expect(withReview).toContain('<h3><a href="/musea/voorbeeld-museum">Voorbeeldmuseum</a></h3>');
    expect(withReview).toContain('Mooi &lt;b&gt;huis&lt;/b&gt;');
    expect(withReview).toContain('>Meer<');
    expect(withReview).not.toContain('deelt nog niets');
    const none = render('/u/anna_b', detail(), profile());
    expect(none).not.toContain('profile-reviews');
  });

  it('escapes a hostile name', () => {
    const html = render('/u/anna_b', detail(), profile({ display_name: '<img src=x onerror=alert(1)>' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});
