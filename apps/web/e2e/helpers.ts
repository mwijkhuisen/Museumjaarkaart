import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page } from '@playwright/test';

// Shared by the page specs. UI text is read from the message files (never hard-coded), so a copy change
// cannot make a spec drift. stack.sh runs Playwright from apps/web.

export type Locale = 'nl' | 'en';
export const messages = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));

export const LOCALES: Locale[] = ['nl', 'en'];
export const museumPath = (locale: Locale, slug: string) =>
  locale === 'en' ? `/en/museums/${slug}` : `/musea/${slug}`;
export const HOSTILE_SLUG = 'hostile-museum-zwolle';

export type Detail = {
  slug: string;
  name: string;
  name_en: string | null;
  street: string | null;
  province_code: string | null;
  place: string | null;
  museumkaart_status: 'participating' | 'left' | 'unknown';
  description_nl: string | null;
  description_en: string | null;
};

export const museumDetail = async (request: APIRequestContext, slug: string): Promise<Detail> => {
  const res = await request.get(`/api/v1/museums/${slug}`);
  if (!res.ok()) throw new Error(`museum ${slug}: ${res.status()}`);
  return (await res.json()) as Detail;
};

/** A seeded museum (never the hostile one) with a street and the Museumkaart, found through the API. */
export const normalMuseum = async (request: APIRequestContext): Promise<Detail> => {
  const list = (await (await request.get('/api/v1/museums?limit=50')).json()) as { items: { slug: string }[] };
  for (const { slug } of list.items) {
    if (slug === HOSTILE_SLUG) continue;
    const d = await museumDetail(request, slug);
    if (d.street !== null && d.province_code !== null && d.museumkaart_status === 'participating') return d;
  }
  throw new Error('no seeded museum with a street and the Museumkaart');
};

export const mkWord = (msg: Record<string, string>, status: Detail['museumkaart_status']) =>
  msg[{ participating: 'mk_participating', left: 'mk_left', unknown: 'mk_unknown' }[status]] as string;

/** The URL of each page kind, per locale. */
export const pageKinds = (locale: Locale, slug: string): Record<string, string> => {
  const en = locale === 'en';
  const p = (nl: string, e: string) => (en ? `/en/${e}` : `/${nl}`);
  return {
    home: en ? '/en/' : '/',
    list: p('musea', 'museums'),
    province: p('provincie/utrecht', 'province/utrecht'),
    museum: museumPath(locale, slug),
    search: `${p('zoeken', 'search')}?q=museum`,
    map: p('kaart', 'map'),
    legal: p('privacy', 'privacy'),
    shell: p('paspoort', 'passport'),
  };
};

export const mapPath = (locale: Locale, query = '') => `${locale === 'en' ? '/en/map' : '/kaart'}${query}`;

/** One NL message by key, for the specs that click and read the screens. */
export const t = (key: string): string => messages('nl')[key] as string;

/**
 * The mail sink (deploy/e2e/mail-sink.mjs, Lettermint's stand-in) as the specs read it: the 6-digit code of the
 * next mail to `to`. Each call waits for a mail newer than the last one it returned, so the second sign-in of an
 * address never reads the first one's code. The runner asks, not the page: no page request leaves the host.
 */
export function mailbox(request: APIRequestContext, to: string) {
  const url = process.env.E2E_MAIL_URL;
  if (!url) throw new Error('E2E_MAIL_URL is required: run deploy/e2e/stack.sh');
  let seen = 0;
  return {
    async code(): Promise<string> {
      let code = '';
      await expect
        .poll(
          async () => {
            const res = await request.get(`${url}/messages`, { params: { to } });
            const list = (await res.json()) as { text: string }[];
            if (list.length <= seen) return '';
            seen = list.length;
            code = /\b(\d{6})\b/.exec(list[0]?.text ?? '')?.[1] ?? '';
            return code;
          },
          { message: 'a mail with a code', timeout: 30_000 },
        )
        .toMatch(/^\d{6}$/);
      return code;
    },
  };
}

/** Opens the map page and waits for the lazy chunk, the tiles and the points: `data-map-state="ready"`. */
export async function openMap(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#museum-map')).toHaveAttribute('data-map-state', 'ready', { timeout: 30_000 });
}
