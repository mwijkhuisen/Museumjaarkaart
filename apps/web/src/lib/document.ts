import { jsonForScript } from './json-script.ts';
import type { Locale } from './routes.ts';

// The whole HTML document (A§15.1, ADR-0009). The only <script> elements without `src` are the two
// data blocks, both written by jsonForScript; every other piece is React's escaped markup or a
// hashed asset path from our own build. No inline script, no <style>, no style= (A§15.6).

/** The client build's files for the entry, from Vite's manifest. */
export type Assets = { script: string; css: readonly string[]; preload: readonly string[] };

/** Every asset path is ours: `/assets/` plus a hashed file name. */
const ASSET = /^\/assets\/[A-Za-z0-9._-]+$/;

const asset = (path: string): string => {
  if (!ASSET.test(path)) throw new Error('unexpected_asset_path');
  return path;
};

export type DocumentParts = {
  locale: Locale;
  /** Static markup of the head elements (title, meta, links). */
  head: string;
  /** The app's markup, hydrated into #app. */
  app: string;
  assets: Assets;
  /** false for error documents: static HTML, no client script and no state. */
  hydrate: boolean;
  /** `mjk-state`: API path → the API's JSON, in the page's fetch order. */
  state: Readonly<Record<string, unknown>>;
  /** JSON-LD for the head, or null. */
  jsonLd: object | null;
};

export function documentHtml(d: DocumentParts): string {
  const lang = d.locale === 'en' ? 'en' : 'nl';
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    d.head,
    ...d.assets.css.map((href) => `<link rel="stylesheet" href="${asset(href)}">`),
  ];
  if (d.hydrate) {
    head.push(...d.assets.preload.map((href) => `<link rel="modulepreload" href="${asset(href)}">`));
    head.push(`<script type="module" src="${asset(d.assets.script)}"></script>`);
  }
  if (d.jsonLd !== null) head.push(`<script type="application/ld+json">${jsonForScript(d.jsonLd)}</script>`);
  const state = d.hydrate ? `<script type="application/json" id="mjk-state">${jsonForScript(d.state)}</script>` : '';
  return `<!doctype html><html lang="${lang}"><head>${head.join('')}</head><body><div id="app">${d.app}</div>${state}</body></html>`;
}
