import { BulkResult, ImportConfirm, ImportPreview, type SavingsYear } from '@mjk/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { ExportSection, exportErrorText } from '../src/components/passport/ExportSection.tsx';
import {
  bodyTooBig,
  confirmBody,
  formatOf,
  IMPORT_MAX_BYTES,
  ImportFlow,
  importErrorText,
  Preview,
} from '../src/components/passport/ImportFlow.tsx';
import { Savings } from '../src/components/passport/Savings.tsx';
import { ApiError, createQueryClient, sendJson } from '../src/lib/api.ts';
import { formatMoney } from '../src/lib/format.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import type { Locale } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';
import { saveInBatches } from '../src/routes/Onboarding.tsx';

// The screens of P2c (WP9). Server rendering never gets past the heading and "Loading" (the member
// is not known before the browser asks, A§15.1) and the node environment has no DOM, so the
// screens are rendered from props and the logic is tested apart. Network goes through msw.

const config = {
  brand: 'Testmerk',
  controller: 'Test Beheerder',
  contactEmail: 'info@mjk.test',
  media: 'https://media.mjk.test',
};
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function page(path: string, locale: Locale): string {
  setLocale(locale, { reload: false });
  return renderToStaticMarkup(<App path={path} queryClient={createQueryClient()} config={config} />);
}

const museum = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  slug: `museum-${n}`,
  name: `Museum ${n}`,
  name_en: null,
  place: 'Haarlem',
  ...over,
});

describe.each([
  {
    locale: 'nl',
    paths: ['/paspoort', '/verlanglijst', '/welkom'],
    h1s: ['Paspoort', 'Verlanglijst', 'Welke musea heb je al bezocht?'],
    loading: 'Laden…',
  },
  {
    locale: 'en',
    paths: ['/en/passport', '/en/wishlist', '/en/welcome'],
    h1s: ['Passport', 'Wishlist', 'Which museums have you already visited?'],
    loading: 'Loading…',
  },
] as const)('the passport pages in $locale', ({ locale, paths, h1s, loading }) => {
  it.each([0, 1, 2])('page %i renders the heading and the loading state only, for everyone', (i) => {
    const html = page(paths[i] as string, locale);
    expect(html).toContain(`<h1>${h1s[i]}</h1>`);
    expect(html).toContain(loading);
    expect(html).not.toContain('style=');
    // Only the page's own content: the layout's header and footer have forms and lists.
    const main = /<main\b[^>]*>(.*?)<\/main>/s.exec(html)?.[1] ?? '';
    expect(main).toContain(loading);
    expect(main).not.toMatch(/<form|<input|<button|<ul/);
  });
});

describe('formatMoney', () => {
  it('formats euro cents in both languages, a negative net included', () => {
    expect(formatMoney(1250, 'nl').replace(/\s/g, ' ')).toBe('€ 12,50');
    expect(formatMoney(1250, 'en')).toBe('€12.50');
    expect(formatMoney(-500, 'en')).toBe('-€5.00');
    expect(formatMoney(0, 'nl').replace(/\s/g, ' ')).toBe('€ 0,00');
  });
});

describe('Savings', () => {
  const year = (over: Partial<SavingsYear> = {}): SavingsYear => ({
    year: 2026,
    card_type: 'adult',
    saved_cents: 12000,
    counted: 7,
    card_price_cents: 8000,
    net_cents: 4000,
    reason: null,
    unpriced: [],
    ...over,
  });
  const render = (savings: SavingsYear[], locale: Locale) => {
    setLocale(locale, { reload: false });
    return renderToStaticMarkup(
      <RouterProvider initialPath="/paspoort">
        <Savings savings={savings} locale={locale} />
      </RouterProvider>,
    );
  };

  it('shows saved, the card price and the net figure, and the adult-price estimate note', () => {
    const html = render([year()], 'en');
    expect(html).toContain('€120.00');
    expect(html).toContain('€80.00');
    expect(html).toContain('€40.00');
    expect(html).toContain('adult price');
    expect(html).not.toContain('style=');
  });

  it('says there is no card price instead of a net figure', () => {
    const html = render([year({ card_price_cents: null, net_cents: null, reason: 'no_card_price' })], 'nl');
    expect(html).toContain('Geen kaartprijs bekend');
    expect(html).not.toContain('Prijs van de kaart');
  });

  it('names the unpriced museums, marks stale ones, and links only museums that are still public', () => {
    const html = render(
      [
        year({
          unpriced: [
            { museum: museum(1), stale: true },
            { museum: museum(2, { slug: null, name: 'Verborgen' }), stale: false },
          ],
        }),
      ],
      'nl',
    );
    expect(html).toContain('<a href="/musea/museum-1">Museum 1</a>');
    expect(html).toMatch(/Museum 1<\/a><span class="muted"> \(prijs verouderd\)/);
    expect(html).toContain('<span>Verborgen</span>');
    expect(html).not.toContain('/museum/null');
  });

  it('lists the newest year first', () => {
    const html = render([year({ year: 2025 }), year({ year: 2026 })], 'en');
    expect(html.indexOf('<h3>2026</h3>')).toBeLessThan(html.indexOf('<h3>2025</h3>'));
  });
});

describe('the import', () => {
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    row: n,
    kind: 'visit',
    name: `Naam ${n}`,
    place: null,
    visited_on: '2026-03-01',
    note: null,
    rating: null,
    review: null,
    status: 'matched',
    error: null,
    museum: museum(n),
    candidates: [],
    ...over,
  });
  const preview = ImportPreview.parse({
    id: ID(99),
    format: 'csv',
    rows: [
      row(1),
      row(2),
      row(3, { status: 'ambiguous', museum: null, candidates: [museum(31), museum(32)] }),
      row(4, { status: 'unmatched', museum: null }),
      row(5, { status: 'invalid', error: 'bad_date', museum: null }),
    ],
    counts: { matched: 2, ambiguous: 1, unmatched: 1, invalid: 1 },
  });

  it('reads .json as our own format and anything else as CSV', () => {
    expect(formatOf('Export.JSON')).toBe('mjk');
    expect(formatOf('bezoeken.csv')).toBe('csv');
    expect(formatOf('bezoeken.txt')).toBe('csv');
  });

  it('confirms with the matched rows unticked as skip and only real picks as choose', () => {
    const body = confirmBody(
      preview,
      new Set([2, 3]),
      new Map([
        [3, ID(31)],
        [4, ID(41)],
        [1, ID(11)],
        [5, ID(51)],
      ]),
    );
    // Row 3 is not matched (skip ignored); rows 1 (matched) and 5 (invalid) cannot be chosen.
    expect(body).toEqual({
      choose: [
        { row: 3, museum_id: ID(31) },
        { row: 4, museum_id: ID(41) },
      ],
      skip: [2],
    });
    expect(ImportConfirm.safeParse(body).success).toBe(true);
  });

  it('turns the upload and confirm statuses into their own text', () => {
    setLocale('en', { reload: false });
    expect(importErrorText(new ApiError(413, 'too_large', [], null))).toContain('too big');
    expect(importErrorText(new ApiError(422, 'unprocessable', [], null))).toContain('could not read');
    expect(importErrorText(new ApiError(409, 'conflict', [], null))).toContain('already been imported');
    expect(importErrorText(new TypeError('fetch failed'))).toContain('No connection');
  });

  it('renders the file input, labelled and limited to .csv and .json', () => {
    setLocale('nl', { reload: false });
    const html = renderToStaticMarkup(<ImportFlow locale="nl" />);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.csv,\.json,text\/csv,application\/json"/);
    expect(html).toMatch(/<label for="[^"]+">Bestand \(\.csv of \.json\)<\/label>/);
    expect(html).not.toContain('style=');
  });

  it('measures the 2 MiB cap on the JSON body in UTF-8, not on the file', () => {
    const body = (content: string) => ({ format: 'csv' as const, content });
    expect(bodyTooBig(body('museum\nA\n'))).toBe(false);
    // 1 MiB of line breaks is over 2 MiB once escaped, and so is 1 MiB of "é" (two bytes each).
    expect(bodyTooBig(body('\n'.repeat(IMPORT_MAX_BYTES / 2)))).toBe(true);
    expect(bodyTooBig(body('é'.repeat(IMPORT_MAX_BYTES / 2)))).toBe(true);
    const wrapper = JSON.stringify(body('')).length;
    expect(bodyTooBig(body('a'.repeat(IMPORT_MAX_BYTES - wrapper)))).toBe(false);
    expect(bodyTooBig(body('a'.repeat(IMPORT_MAX_BYTES - wrapper + 1)))).toBe(true);
  });

  it('renders the preview grouped: matched ticked, picks and a search for ambiguous, a search for unmatched, invalid in words', () => {
    setLocale('nl', { reload: false });
    const html = renderToStaticMarkup(<Preview preview={preview} locale="nl" onDone={() => {}} onCancel={() => {}} />);
    expect(html).not.toContain('style=');
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(html).toContain('Welk museum bedoel je?');
    expect(html).toContain('Museum 31');
    // The ambiguous row has its candidates as quick picks and the search the unmatched row has.
    expect(html.match(/type="search"/g)).toHaveLength(2);
    expect(html).toContain('de datum is niet te lezen');
    expect(html).toContain('2 herkend, 1 twijfelachtig, 1 niet gevonden, 1 ongeldig.');
    // Two matched rows apply; nothing is picked for the others yet.
    expect(html).toContain('2 toepassen');
  });
});

describe('the export section', () => {
  it('renders the start button and the refresh button, with no member data before the fetch', () => {
    setLocale('en', { reload: false });
    const html = renderToStaticMarkup(<ExportSection locale="en" />);
    expect(html).toContain('Download my data');
    expect(html).toContain('Make an export');
    expect(html).not.toContain('/api/v1/me/exports/');
    expect(html).not.toContain('style=');
  });

  it('says what 409 and 429 mean', () => {
    setLocale('en', { reload: false });
    expect(exportErrorText(new ApiError(409, 'conflict', [], null))).toContain('already being made');
    expect(exportErrorText(new ApiError(429, 'rate_limited', [], 3600))).toContain('three exports a day');
  });
});

// The bulk save goes through the real `sendJson`, with `fetch` answered by a stub (msw's global
// server lives outside this project's tsconfig; nothing here reaches the network either way).
describe('saveInBatches', () => {
  afterEach(() => vi.unstubAllGlobals());

  const send = (batch: string[]) => sendJson('POST', '/api/v1/me/visits/bulk', { museum_ids: batch }, BulkResult);
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('sends at most 200 ids at a time, in order, and adds the answers up', async () => {
    const sizes: number[] = [];
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      expect(path).toBe('/api/v1/me/visits/bulk');
      const { museum_ids } = JSON.parse(String(init.body)) as { museum_ids: string[] };
      sizes.push(museum_ids.length);
      return json({ added: museum_ids.length - 1, skipped: 1 });
    });
    const out = await saveInBatches(
      Array.from({ length: 450 }, (_, i) => ID(i)),
      send,
    );
    expect(sizes).toEqual([200, 200, 50]);
    expect(out).toEqual({ added: 447, skipped: 3, done: 450, error: null });
  });

  it('stops at the first failing batch and says how many ids were accepted', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1
        ? json({ added: 200, skipped: 0 })
        : json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
    });
    const out = await saveInBatches(
      Array.from({ length: 450 }, (_, i) => ID(i)),
      send,
    );
    expect(calls).toBe(2);
    expect(out).toMatchObject({ added: 200, skipped: 0, done: 200 });
    expect(out.error).toBeInstanceOf(ApiError);
    expect((out.error as ApiError).status).toBe(429);
  });

  it('sends nothing for an empty selection', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await saveInBatches([], send)).toEqual({ added: 0, skipped: 0, done: 0, error: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
