import {
  MkList,
  type MuseumDetail,
  MuseumDetail as MuseumDetailSchema,
  type MuseumList,
  MuseumList as MuseumListSchema,
  PROVINCE_CODES,
  Provinces,
} from '@mjk/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/lib/api.ts';
import { apiPath, apiPathsOf, type Route, routeOf } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';

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
    mk_list: { published_on: '2026-11-05', n: 512, member: true },
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
function seed(route: Route, museum: MuseumDetail): Map<string, unknown> {
  const data = new Map<string, unknown>();
  for (const path of apiPathsOf(route)) {
    if (path === apiPath.provinces) data.set(path, provinces);
    else if (path === apiPath.mkList) data.set(path, mkList);
    else if (path.startsWith('/api/v1/museums/')) data.set(path, museum);
    else data.set(path, list());
  }
  return data;
}

function render(path: string, museum: MuseumDetail = detail()): string {
  const resolved = routeOf(path);
  if (resolved.kind !== 'route') throw new Error('not a route');
  setLocale(resolved.route.locale, { reload: false });
  const queryClient = createQueryClient();
  for (const [key, value] of seed(resolved.route, museum)) queryClient.setQueryData([key], value);
  return renderToStaticMarkup(
    <App
      path={path}
      queryClient={queryClient}
      config={{ brand: 'Testmerk', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' }}
    />,
  );
}

const PATHS = [
  '/',
  '/musea',
  '/musea/voorbeeld-museum',
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
          config={{ brand: 'Testmerk', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' }}
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
