import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ApiResult,
  type FetchApi,
  MkList,
  MuseumDetail,
  MuseumList,
  PROVINCE_CODES,
  Provinces,
  type SsrBundle,
  UserProfile,
} from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb } from '../build.ts';
import { parseHex } from '../src/lib/map/museumLayer.ts';
import { REVIEW_ID, review, reviewList } from './review-fixture.ts';

// P1c criterion 3: the built client and the rendered HTML of every page kind make no inline script,
// style, handler or third-party fetch (A§15.6, A§18). The scan output goes into the PR as evidence.

const CONFIG = { brand: 'Testmerk', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' };
const SELF = 'https://mjk.test';

/** Inert identifiers in the bundles: namespaces and error-message links, never fetched. */
const ALLOWED_URLS = [
  'https://react.dev/errors/',
  'https://react.dev/link/',
  'http://www.w3.org/',
  'https://www.w3.org/',
  'https://schema.org',
  'http://schema.org',
  // Zod's JSON-schema `$schema` ids, Paraglide's error doc link, URL-parse bases and an IPv6 template.
  'https://json-schema.org/',
  'http://json-schema.org/',
  'https://paraglidejs.com/errors',
  'http://fallback.com',
  'http://example.com',
  'http://[${',
  // The link-outs of a Commons image's caption (`@mjk/contracts` commons.ts, ADR-0018): `<a href>` navigations, never fetched.
  'https://creativecommons.org/',
  'https://commons.wikimedia.org/wiki/File:',
  // MapLibre's and pmtiles' bundles (A§15.3; inspected in P1d, all inert: none is fetched by code we run).
  // The href of MapLibre's opt-in logo control and of its default attribution text: we pass
  // `attributionControl: { compact: true }` and never `maplibreLogo`, so neither renders, and an
  // <a href> is a navigation, not a request.
  'https://maplibre.org/',
  // A licence header, a console warning and a console error: text, never fetched.
  'https://github.com/maplibre/maplibre-gl-js/blob/',
  'https://github.com/mapbox/mapbox-gl-js/issues/',
  'https://github.com/protomaps/PMTiles/',
  // The message of MapLibre's GPUInitializationError (no WebGL2): text, never fetched (allowed by
  // name in test/forbidden-hosts.test.ts).
  'https://wiki.openstreetmap.org/wiki/This_map_requires_WebGL',
  // Our own media origin, `https://media.${hostname}` (the tiles; the CSP's connect-src): built at
  // run time from the page's own hostname, in the lazy map chunk only.
  'https://media.${',
  // The base of a `new URL(attribute, base)` that only reads the protocol of an attribute value.
  'https://maplibre.invalid/',
  // ALTCHA's widget (`altcha/external`, a lazy chunk; inspected in P2a, all inert). The href of its
  // logo link and the default English footer string (an <a href>, a navigation, not a request): we
  // pass `hideLogo` and `hideFooter` and override the English strings with our own (footer empty).
  'https://altcha.org',
  // Svelte's error texts ("https://svelte.dev/e/<code>"): console messages, never fetched.
  'https://svelte.dev/e/',
  // @simplewebauthn/browser (a lazy chunk, P2b): the link inside the console.warn of its legacy-call
  // check, in startAuthentication and startRegistration. Text, never fetched; nothing broader.
  'https://simplewebauthn.dev/docs/packages/browser#typeerror-cannot-read-properties-of-undefined-reading-challenge',
];

const item = {
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
  rating_count: 12,
  rating_mean: 4.3,
};
const detail = MuseumDetail.parse({
  ...item,
  description_nl: 'Een Nederlandse beschrijving.',
  description_en: 'An English description.',
  street: 'Kerkstraat',
  house_number: '12',
  postcode: '2011 AB',
  website: 'https://example.org/',
  museumnl_url: null,
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
    collection: { mean: 4.5, count: 6 },
    presentation: { mean: null, count: 2 },
    kid_friendly: { mean: null, count: 0 },
    accessibility: { mean: null, count: 0 },
    facilities: { mean: null, count: 0 },
    value_for_money: { mean: null, count: 0 },
  },
});
const list = MuseumList.parse({ items: [item], next_cursor: 'abc123', total: 1 });
const provinces = Provinces.parse({
  items: PROVINCE_CODES.map((code, i) => ({
    code,
    name_nl: `Provincie ${code}`,
    name_en: `Province ${code}`,
    museum_count: i + 1,
  })),
});
const mkList = MkList.parse({ list: { published_on: '2026-11-05', n: 512 } });

const profile = UserProfile.parse({
  handle: 'anna_b',
  display_name: 'Anna de Vries',
  member_since: '2026-03',
  indexable: false,
  progress: null,
  visits: null,
  wishlist: null,
});

const answer = (status: number, body: unknown = null): ApiResult => ({ status, location: null, body });
/** Contract-valid answers, or one failing status for every path. */
const fake =
  (failure?: number): FetchApi =>
  async (path) => {
    if (failure !== undefined) return answer(failure);
    if (path === '/api/v1/provinces') return answer(200, provinces);
    if (path === '/api/v1/mk-list') return answer(200, mkList);
    if (path === '/api/v1/users/anna_b') return answer(200, profile);
    if (/\/reviews$/.test(path)) return answer(200, reviewList());
    if (path.startsWith('/api/v1/reviews/')) return answer(200, review());
    if (/^\/api\/v1\/museums\/[^/?]+$/.test(path)) return answer(200, detail);
    return answer(200, list);
  };

type Kind = [name: string, nl: string, en: string, failure?: number];
const KINDS: Kind[] = [
  ['home', '/', '/en/'],
  ['list', '/musea', '/en/museums'],
  ['province', '/provincie/noord-holland', '/en/province/noord-holland'],
  ['museum', '/musea/voorbeeld-museum', '/en/museums/voorbeeld-museum'],
  ['search', '/zoeken?q=haarlem', '/en/search?q=haarlem'],
  ['map', '/kaart?province=NL-NH', '/en/map'],
  ['legal', '/privacy', '/en/privacy'],
  ['shell', '/paspoort', '/en/passport'],
  ['signin', '/inloggen', '/en/sign-in'],
  ['account', '/account', '/en/account'],
  ['profile', '/u/anna_b', '/en/u/anna_b'],
  ['museum-reviews', '/musea/voorbeeld-museum/reviews', '/en/museums/voorbeeld-museum/reviews'],
  ['review', `/reviews/${REVIEW_ID}`, `/en/reviews/${REVIEW_ID}`],
  ['404', '/nergens/naartoe', '/en/nowhere/at/all'],
  ['400', '/musea', '/en/museums', 400],
  ['5xx', '/musea', '/en/museums', 503],
];
const PAGES = KINDS.flatMap(([name, nl, en, failure]) => [
  { name: `${name} nl`, path: nl, failure },
  { name: `${name} en`, path: en, failure },
]);

let tmp: string;
const htmls: { name: string; status: number; html: string }[] = [];
const assets: { file: string; text: string }[] = [];
type ManifestChunk = {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
  isDynamicEntry?: boolean;
  isEntry?: boolean;
};
let manifest: Record<string, ManifestChunk> = {};
const ENTRY = 'src/entry-client.tsx';
const MAP_CHUNK = 'src/lib/map/createMap.ts';
const ALTCHA_CHUNK = 'src/components/auth/altcha-load.ts';
const PASSKEY_CHUNK = 'src/lib/passkey.ts';
let adminHtml = '';

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mjk-build-'));
  await buildWeb(tmp);
  const bundle = (await import(pathToFileURL(join(tmp, 'server', 'entry-server.js')).href)) as SsrBundle;
  for (const p of PAGES) {
    const r = await bundle.render(p.path, fake(p.failure), CONFIG);
    htmls.push({ name: p.name, status: r.status, html: r.body });
  }
  manifest = JSON.parse(readFileSync(join(tmp, 'client', '.vite', 'manifest.json'), 'utf8')) as typeof manifest;
  adminHtml = readFileSync(join(tmp, 'client', 'admin.html'), 'utf8');
  const dir = join(tmp, 'client', 'assets');
  for (const file of readdirSync(dir)) assets.push({ file, text: readFileSync(join(dir, file), 'utf8') });
}, 300_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const tagsOf = (html: string) =>
  [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({
    tag: (m[1] as string).toLowerCase(),
    attrs: m[2] as string,
  }));
const attrsOf = (attrs: string) =>
  [...attrs.matchAll(/([a-z][a-z-]*)="([^"]*)"/gi)].map((m) => [m[1] as string, m[2] as string] as const);
const ABSOLUTE = /^(https?:)?\/\//i;

describe('the rendered HTML of every page kind', () => {
  it('has the status each kind should', () => {
    const statuses = Object.fromEntries(htmls.map((h) => [h.name, h.status]));
    expect(statuses['404 nl']).toBe(404);
    expect(statuses['400 en']).toBe(400);
    expect(statuses['5xx nl']).toBe(503);
    expect(statuses['museum en']).toBe(200);
  });

  it('holds no inline script, style, handler, javascript:, data: or blob:', () => {
    for (const { name, html } of htmls) {
      for (const { tag, attrs } of tagsOf(html)) {
        if (tag === 'script' && !/\bsrc=/.test(attrs)) {
          expect(attrs.trim(), name).toMatch(/^type="application\/(json" id="mjk-state|ld\+json)"$/);
        }
        expect(attrs, `${name} <${tag}>`).not.toMatch(/(^|\s)style=/i);
        expect(attrs, `${name} <${tag}>`).not.toMatch(/\son[a-z]+=/i);
      }
      expect(html, name).not.toContain('<style');
      expect(html, name).not.toMatch(/javascript:/i);
      expect(html, name).not.toMatch(/\b(?:data|blob):/i);
    }
  });

  it('fetches nothing from another host', () => {
    const linkOuts = new Map<string, number>();
    for (const { name, html } of htmls) {
      for (const { tag, attrs } of tagsOf(html)) {
        for (const [attr, v] of attrsOf(attrs)) {
          if (!/^(src|href|srcset|action|poster|data|content)$/i.test(attr)) continue;
          if (tag === 'a' && attr === 'href') {
            if (ABSOLUTE.test(v)) linkOuts.set(v, (linkOuts.get(v) ?? 0) + 1);
          } else if (tag === 'meta' && v === `https://media.${CONFIG.domain}` && /name="mjk-media"/.test(attrs)) {
            // The photo origin the client reads (P3b): data for the page's own <img>, fetched by nothing.
          } else if (ABSOLUTE.test(v)) {
            expect(v === SELF || v.startsWith(`${SELF}/`), `${name} <${tag} ${attr}>`).toBe(true);
          }
        }
      }
      expect(html, name).not.toMatch(/url\(/i);
    }
    console.log(
      `build scan: ${htmls.length} pages (${PAGES.length / 2} kinds x nl/en), link-outs (<a href>, navigations): ${JSON.stringify([...linkOuts])}, findings 0`,
    );
  });
});

describe('the prefs script (P3a: the rating fold, src/prefs.ts)', () => {
  const PREFS = 'src/prefs.ts';
  const SRC = /^<script src="\/assets\/prefs-[A-Za-z0-9_-]+\.js"><\/script>$/;

  it('is a manifest entry whose file is a classic script under 1 kB: no import, export or preload polyfill', () => {
    const entry = manifest[PREFS];
    expect(entry?.isEntry).toBe(true);
    expect(entry?.imports ?? []).toEqual([]);
    expect(entry?.file).toMatch(/^assets\/prefs-[A-Za-z0-9_-]+\.js$/);
    const text = readFileSync(join(tmp, 'client', entry?.file ?? 'missing'), 'utf8');
    expect(text.length).toBeLessThan(1024);
    expect(text).not.toMatch(/\bimport\b|\bexport\b|modulepreload/);
    expect(text).toContain('mjk-hide-ratings');
    expect(text).toContain('data-hide-ratings');
  });

  it('comes right after the two metas of a hydrated document, as a classic script with no async, defer or type', () => {
    for (const { name, html } of htmls.filter((h) => !/^(404|400|5xx) /.test(h.name))) {
      const head = /<head>(.*?)<\/head>/s.exec(html)?.[1] ?? '';
      const [charset, viewport, prefs] = head.match(/<(?:meta|script)\b[^>]*>(?:<\/script>)?/g) ?? [];
      expect(charset, name).toBe('<meta charset="utf-8">');
      expect(viewport, name).toBe('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(prefs, name).toMatch(SRC);
      expect(head.indexOf(prefs ?? '?'), name).toBe((charset?.length ?? 0) + (viewport?.length ?? 0));
    }
  });

  it('is the only script besides the entry module and the two data blocks, and an error document has none', () => {
    for (const { name, html } of htmls) {
      const scripts = tagsOf(html).filter((t) => t.tag === 'script');
      if (/^(404|400|5xx) /.test(name)) {
        expect(scripts, name).toEqual([]);
        continue;
      }
      const bySrc = scripts.filter((t) => /\bsrc=/.test(t.attrs));
      expect(bySrc, name).toHaveLength(2);
      expect(
        bySrc.map((t) => t.attrs.trim()).filter((a) => /^src="\/assets\/prefs-[\w-]+\.js"$/.test(a)),
        name,
      ).toHaveLength(1);
    }
  });
});

describe('the admin entry (dist/client/admin.html, A§15.1)', () => {
  it('is an empty #admin root and one module script, with no inline script, style, handler, data: or other host', () => {
    expect(adminHtml).toMatch(/<body>\s*<div id="admin"><\/div>\s*<\/body>/);
    const tags = tagsOf(adminHtml);
    const scripts = tags.filter((t) => t.tag === 'script');
    expect(scripts).toHaveLength(1);
    for (const { tag, attrs } of tags) {
      if (tag === 'script') expect(attrs).toMatch(/type="module"[^>]*\bsrc="\/assets\/admin-[\w-]+\.js"/);
      expect(attrs, `<${tag}>`).not.toMatch(/(^|\s)style=/i);
      expect(attrs, `<${tag}>`).not.toMatch(/\son[a-z]+=/i);
      for (const [attr, v] of attrsOf(attrs)) {
        if (/^(src|href|srcset|action|poster|data)$/i.test(attr)) expect(v, `<${tag} ${attr}>`).not.toMatch(ABSOLUTE);
      }
    }
    expect(adminHtml).not.toContain('<style');
    expect(adminHtml).not.toMatch(/javascript:/i);
    expect(adminHtml).not.toMatch(/\b(?:data|blob):/i);
    expect(adminHtml).not.toMatch(/url\(/i);
    expect(adminHtml).toContain('<html lang="nl">');
  });

  it('leaves the public entry key in the manifest for the ssr bundle', () => {
    expect(manifest[ENTRY]?.isEntry).toBe(true);
    expect(manifest['admin.html']?.isEntry).toBe(true);
  });
});

describe('the app-shell pages', () => {
  it('server-render the heading and the loading state only', () => {
    for (const name of ['signin nl', 'signin en', 'account nl', 'account en']) {
      const html = htmls.find((h) => h.name === name)?.html ?? '';
      expect(html, name).toContain('<h1>');
      expect(html, name).not.toMatch(/<form|<input|altcha/i);
    }
  });
});

describe('the map page', () => {
  it('is server-rendered with its filters and its list, and holds no map code', () => {
    for (const name of ['map nl', 'map en']) {
      const html = htmls.find((h) => h.name === name)?.html ?? '';
      expect(html, name).toContain('class="filters"');
      expect(html, name).toContain('class="card-list"');
      expect(html, name).toContain('Voorbeeldmuseum');
      expect(html, name).not.toMatch(/maplibre|pmtiles|createMap|museum-map|<canvas/i);
    }
    expect(htmls.find((h) => h.name === 'map nl')?.html).toContain('<option value="NL-NH" selected="">');
  });
});

describe('the client assets', () => {
  /** MapLibre's own stylesheet: the CSS of the lazy map chunk (by the manifest) that holds `.maplibregl-` rules. */
  const isMaplibreCss = (file: string, text: string) =>
    (manifest[MAP_CHUNK]?.css ?? []).includes(`assets/${file}`) && /\.maplibregl-/.test(text);

  it("holds no data: or blob: in CSS (MapLibre's own SVG icons excepted) and only inert absolute URLs in JS and CSS", () => {
    const found: Record<string, number> = Object.fromEntries(ALLOWED_URLS.map((u) => [u, 0]));
    const other: string[] = [];
    let maplibreData = 0;
    let maplibreCss = 0;
    for (const { file, text } of assets) {
      if (file.endsWith('.css')) {
        expect(text, file).not.toMatch(/\bblob:/i);
        expect(text, file).not.toMatch(/@import/i);
        if (isMaplibreCss(file, text)) {
          // The one exception (A§15.6 `img-src data:`): MapLibre's control icons, each an inline SVG.
          maplibreCss++;
          maplibreData = (text.match(/\bdata:image\/svg\+xml[,;]/gi) ?? []).length;
          expect(text.match(/\bdata:/gi)?.length, `${file}: every data: URL is an SVG image`).toBe(maplibreData);
        } else {
          expect(text, file).not.toMatch(/\bdata:/i);
        }
      }
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
        const hit = ALLOWED_URLS.find((u) => m[0].startsWith(u));
        if (hit === undefined) other.push(`${file}: ${m[0]}`);
        else found[hit] = (found[hit] ?? 0) + 1;
      }
    }
    expect(maplibreCss, "MapLibre's stylesheet is found").toBe(1);
    console.log(
      `build scan: ${assets.length} client assets; MapLibre's CSS holds ${maplibreData} data:image/svg+xml URLs, the only data: in any CSS; absolute URLs per allow-list entry ${JSON.stringify(found)}; findings ${other.length}`,
    );
    expect(other).toEqual([]);
  });

  it('fetches only same-origin relative paths', () => {
    const positions = [
      /\bfetch\(\s*(["'`])([^"'`]*)\1/g,
      /\bimport\(\s*(["'`])([^"'`]*)\1/g,
      /\burl\(\s*(["']?)([^"')]*)\1\s*\)/g,
      /\bnew URL\(\s*(["'`])([^"'`]*)\1/g,
    ];
    let n = 0;
    for (const { file, text } of assets) {
      for (const re of positions) {
        for (const m of text.matchAll(re)) {
          // MapLibre's stylesheet draws its icons with inline SVG data: URLs (checked above).
          if (isMaplibreCss(file, text) && /^data:image\/svg\+xml[,;]/i.test(m[2] ?? '')) continue;
          n++;
          expect(m[2], `${file}: ${m[0]}`).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
        }
      }
    }
    console.log(`build scan: ${n} fetch/import/url/new URL positions, all same-origin`);
  });
});

describe('the map marker tokens in the built stylesheet', () => {
  // The CSS minifier rewrites colours (`#ffffff` becomes `#fff`): the map reads them at mount.
  it('still parse after minification', () => {
    const css = assets
      .filter((a) => a.file.endsWith('.css'))
      .map((a) => a.text)
      .join('\n');
    for (const name of ['mk', 'other', 'cluster', 'outline']) {
      const value = new RegExp(`--color-map-${name}:\\s*([^;}]+)`).exec(css)?.[1];
      expect(value, name).toBeDefined();
      expect(() => parseHex((value ?? '').trim()), `${name}: ${value}`).not.toThrow();
    }
  });
});

describe('the lazy ALTCHA chunk (P2a)', () => {
  const staticKeys = (key: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key)) return seen;
    seen.add(key);
    for (const dep of manifest[key]?.imports ?? []) staticKeys(dep, seen);
    return seen;
  };
  const text = (key: string) => readFileSync(join(tmp, 'client', manifest[key]?.file ?? 'missing'), 'utf8');

  it('keeps the widget out of everything either entry imports, and puts it, its stylesheet and its SHA-256 worker in one lazy chunk', () => {
    for (const entry of [ENTRY, 'admin.html']) {
      expect(manifest[entry]?.imports ?? [], `${entry} has no static import of the widget chunk`).not.toContain(
        ALTCHA_CHUNK,
      );
      for (const key of staticKeys(entry)) {
        // `altcha-checkbox` is a class name inside the widget's own templates, not in our code.
        expect(text(key), `${entry}: ${manifest[key]?.file}`).not.toContain('altcha-checkbox');
      }
    }
    const lazy = manifest[ALTCHA_CHUNK];
    expect(lazy?.isDynamicEntry).toBe(true);
    expect(text(ALTCHA_CHUNK)).toContain('altcha-checkbox');
    expect(lazy?.css?.length, "the widget's stylesheet is part of the lazy chunk").toBeGreaterThan(0);
    expect(
      lazy?.assets?.filter((a) => /\/sha-[\w-]+\.js$/.test(a)),
      'one SHA-256 worker file',
    ).toHaveLength(1);
    // Only SHA-256 (A§9): no argon2id or scrypt worker (WebAssembly, which the CSP forbids), no blob: worker.
    const files = readdirSync(join(tmp, 'client', 'assets'));
    expect(files.filter((f) => /argon2|scrypt|pbkdf2/i.test(f))).toEqual([]);
    expect(text(ALTCHA_CHUNK)).not.toMatch(/WebAssembly|blob:/);
    expect(text(ALTCHA_CHUNK)).toMatch(/new Worker\(`\/assets\/sha-[\w-]+\.js`/);
    for (const f of files.filter((f) => /^sha-.*\.js$/.test(f))) {
      expect(readFileSync(join(tmp, 'client', 'assets', f), 'utf8'), f).not.toMatch(/WebAssembly|blob:/);
    }
    console.log(
      `build scan: ALTCHA lazy chunk ${lazy?.file} (${(text(ALTCHA_CHUNK).length / 1024).toFixed(1)} kB), css ${lazy?.css?.join(', ')}, worker ${lazy?.assets?.join(', ')}; no static import from either entry`,
    );
  });
});

describe('the lazy passkey chunk (P2b)', () => {
  const staticKeys = (key: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key)) return seen;
    seen.add(key);
    for (const dep of manifest[key]?.imports ?? []) staticKeys(dep, seen);
    return seen;
  };
  const text = (key: string) => readFileSync(join(tmp, 'client', manifest[key]?.file ?? 'missing'), 'utf8');

  it('keeps @simplewebauthn/browser out of everything either entry imports, in one lazy chunk without eval, wasm or blob:', () => {
    const lazy = manifest[PASSKEY_CHUNK];
    expect(lazy?.isDynamicEntry).toBe(true);
    // The library's own code (its calls into the browser's credential API), in the lazy chunk only.
    expect(text(PASSKEY_CHUNK)).toContain('navigator.credentials');
    const lazyKeys = [...staticKeys(PASSKEY_CHUNK)];
    for (const entry of [ENTRY, 'admin.html']) {
      expect(manifest[entry]?.imports ?? [], `${entry} has no static import of the passkey chunk`).not.toContain(
        PASSKEY_CHUNK,
      );
      const entryKeys = staticKeys(entry);
      expect(entryKeys.has(PASSKEY_CHUNK), `${entry} reaches the passkey chunk statically`).toBe(false);
      for (const key of entryKeys) {
        expect(text(key), `${entry}: ${manifest[key]?.file}`).not.toContain('navigator.credentials');
      }
    }
    // The chunk and any chunk only it reaches statically: no way to run strings as code, no wasm, no blob: URL.
    const entryKeys = new Set([...staticKeys(ENTRY), ...staticKeys('admin.html')]);
    for (const key of lazyKeys.filter((k) => !entryKeys.has(k))) {
      expect(text(key), manifest[key]?.file).not.toMatch(/\beval\(|new Function|WebAssembly|blob:/);
    }
    console.log(
      `build scan: passkey lazy chunk ${lazy?.file} (${(text(PASSKEY_CHUNK).length / 1024).toFixed(1)} kB); no static import from either entry`,
    );
  });

  it('leaves dist/server holding entry-server.js alone, with no passkey code in it', () => {
    expect(readdirSync(join(tmp, 'server'))).toEqual(['entry-server.js']);
    expect(readFileSync(join(tmp, 'server', 'entry-server.js'), 'utf8')).not.toContain('navigator.credentials');
  });
});

describe('the lazy map chunk (A§15.3)', () => {
  /** Every chunk key the key reaches through static `imports` (the key itself included). */
  const staticKeys = (key: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key)) return seen;
    seen.add(key);
    for (const dep of manifest[key]?.imports ?? []) staticKeys(dep, seen);
    return seen;
  };
  const text = (key: string) => readFileSync(join(tmp, 'client', manifest[key]?.file ?? 'missing'), 'utf8');

  it('keeps maplibre-gl and pmtiles out of everything the entry imports, and puts them in the createMap chunk', () => {
    const entry = manifest[ENTRY];
    expect(entry?.dynamicImports, 'the entry reaches createMap only through import()').toContain(MAP_CHUNK);
    expect(entry?.imports ?? [], 'the entry has no static import of the map chunk').not.toContain(MAP_CHUNK);

    const entryKeys = staticKeys(ENTRY);
    expect(entryKeys.has(MAP_CHUNK)).toBe(false);
    for (const key of entryKeys) {
      expect(text(key), `entry chunk ${manifest[key]?.file}`).not.toMatch(/maplibre|pmtiles/i);
    }

    // The map chunk, plus any chunk only it reaches statically, holds both libraries.
    const lazyKeys = [...staticKeys(MAP_CHUNK)].filter((key) => !entryKeys.has(key));
    expect(lazyKeys).toContain(MAP_CHUNK);
    const lazyText = lazyKeys.map(text).join('\n');
    expect(lazyText).toMatch(/maplibregl-ctrl/);
    expect(lazyText).toMatch(/PMTiles/);
    expect(manifest[MAP_CHUNK]?.isDynamicEntry).toBe(true);
    expect(
      manifest[MAP_CHUNK]?.assets?.some((a) => /maplibre-gl-worker/.test(a)),
      'the worker is a same-origin file',
    ).toBe(true);

    // The entry's stylesheets (what the server links) are not the map's.
    const entryCss = new Set([...entryKeys].flatMap((key) => manifest[key]?.css ?? []));
    for (const css of manifest[MAP_CHUNK]?.css ?? []) expect(entryCss.has(css), css).toBe(false);

    const dir = join(tmp, 'client');
    const listing = [...entryKeys, ...Object.keys(manifest).filter((k) => !entryKeys.has(k))].map((key) => {
      const chunk = manifest[key] as ManifestChunk;
      const where = entryKeys.has(key) ? 'entry (static)' : key === MAP_CHUNK ? 'lazy: maplibre-gl + pmtiles' : 'lazy';
      const sizes = [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])].map(
        (f) => `${f} ${(readFileSync(join(dir, f)).length / 1024).toFixed(1)} kB`,
      );
      return `  ${where.padEnd(28)} ${key}: ${sizes.join(', ')}`;
    });
    console.log(`build scan: client chunks (the entry imports no map code)\n${listing.join('\n')}`);
  });
});
