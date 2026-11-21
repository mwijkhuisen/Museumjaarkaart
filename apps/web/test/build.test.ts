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
} from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb } from '../build.ts';

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
  mk_list: { published_on: '2026-11-05', n: 512, member: true },
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

const answer = (status: number, body: unknown = null): ApiResult => ({ status, location: null, body });
/** Contract-valid answers, or one failing status for every path. */
const fake =
  (failure?: number): FetchApi =>
  async (path) => {
    if (failure !== undefined) return answer(failure);
    if (path === '/api/v1/provinces') return answer(200, provinces);
    if (path === '/api/v1/mk-list') return answer(200, mkList);
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
  ['map', '/kaart', '/en/map'],
  ['legal', '/privacy', '/en/privacy'],
  ['shell', '/paspoort', '/en/passport'],
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

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mjk-build-'));
  await buildWeb(tmp);
  const bundle = (await import(pathToFileURL(join(tmp, 'server', 'entry-server.js')).href)) as SsrBundle;
  for (const p of PAGES) {
    const r = await bundle.render(p.path, fake(p.failure), CONFIG);
    htmls.push({ name: p.name, status: r.status, html: r.body });
  }
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

describe('the client assets', () => {
  it('holds no data: or blob: in CSS and only inert absolute URLs in JS and CSS', () => {
    const found: Record<string, number> = Object.fromEntries(ALLOWED_URLS.map((u) => [u, 0]));
    const other: string[] = [];
    for (const { file, text } of assets) {
      if (file.endsWith('.css')) {
        expect(text, file).not.toMatch(/\b(?:data|blob):/i);
        expect(text, file).not.toMatch(/@import/i);
      }
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
        const hit = ALLOWED_URLS.find((u) => m[0].startsWith(u));
        if (hit === undefined) other.push(`${file}: ${m[0]}`);
        else found[hit] = (found[hit] ?? 0) + 1;
      }
    }
    console.log(
      `build scan: ${assets.length} client assets; absolute URLs per allow-list entry ${JSON.stringify(found)}; findings ${other.length}`,
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
          n++;
          expect(m[2], `${file}: ${m[0]}`).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
        }
      }
    }
    console.log(`build scan: ${n} fetch/import/url/new URL positions, all same-origin`);
  });
});
