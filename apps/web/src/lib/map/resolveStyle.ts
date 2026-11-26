import { MapError } from './errors.ts';
import { SCHEME } from './protocol.ts';
import { TILE_FILE } from './tiles.ts';

/**
 * The generated styles (scripts/build-map-style.ts) carry root-relative glyph and sprite paths and
 * one placeholder source, `pmtiles://basemap`. At run time they become absolute URLs: glyphs and
 * sprite on the page's own origin, the tiles on `media.<domain>`. The build and the style hold no
 * hostname, so one build serves any site.
 */

export interface BaseStyle {
  glyphs?: string;
  sprite?: unknown;
  sources: Record<string, unknown>;
}

const PLACEHOLDER = `${SCHEME}://basemap`;
const ORIGIN = /^https?:\/\/[^/?#]+$/;
const MEDIA = /^https:\/\/media\.[^/?#]+$/;

/** A root-relative path on `origin`. `new URL` would percent-encode the `{fontstack}` template. */
function onOrigin(origin: string, path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
    throw new MapError('style_unexpected');
  return `${origin}${path}`;
}

/** `origin` is `location.origin`, `media` is `https://media.<hostname>`, `file` is from `current.json`. */
export function resolveStyle<S extends BaseStyle>(style: S, file: string, origin: string, media: string): S {
  if (!ORIGIN.test(origin) || !MEDIA.test(media) || !TILE_FILE.test(file)) throw new MapError('style_unexpected');
  if (Object.keys(style.sources).join() !== 'basemap') throw new MapError('style_unexpected');
  const out = structuredClone(style);
  out.glyphs = onOrigin(origin, style.glyphs);
  out.sprite = onOrigin(origin, style.sprite);
  const source = out.sources.basemap as { url?: unknown } | null;
  if (typeof source !== 'object' || source === null || source.url !== PLACEHOLDER)
    throw new MapError('style_unexpected');
  source.url = `${SCHEME}://${media}/tiles/${file}`;
  return out;
}
