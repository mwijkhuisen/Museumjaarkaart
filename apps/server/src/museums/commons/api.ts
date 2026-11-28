// The Wikimedia Commons imageinfo request and its strict parser (ADR-0018). Pure: no I/O, never throws.
// Commons text (names, licence, author) is data; the author HTML is reduced by attribution.ts.

import { z } from 'zod';

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const MAX_FILES_PER_REQUEST = 50;
/** [U] Wikimedia may render only standard widths; the recorded answer shows what it returned. */
export const THUMB_WIDTH = 1920;

// The `museum.commons_file` CHECK: 1 to 255 characters, no control character and none of #<>[]|{}/.
const BAD_FILE_NAME = /[\p{Cc}#<>[\]|{}/]/u;
export function validCommonsFile(name: string): boolean {
  return name.length >= 1 && name.length <= 255 && !BAD_FILE_NAME.test(name);
}

/** The request URL for 1 to 50 file names (without the `File:` prefix); throws a RangeError on a bad input. */
export function imageInfoUrl(files: readonly string[]): string {
  if (files.length < 1 || files.length > MAX_FILES_PER_REQUEST) throw new RangeError('commons_bad_files');
  if (!files.every(validCommonsFile)) throw new RangeError('commons_bad_files');
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'imageinfo',
    iiprop: 'url|sha1|size|mime|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'License|LicenseShortName|Artist|Attribution|Restrictions',
    titles: files.map((f) => `File:${f}`).join('|'),
  });
  return `${COMMONS_API}?${params.toString()}`;
}

export type ImageInfoCode = 'commons_bad_url' | 'commons_bad_response';

export type ImageInfoResult =
  | { file: string; state: 'missing' }
  | {
      file: string;
      state: 'present';
      sha1: string;
      mime: string;
      width: number;
      height: number;
      thumbUrl: string;
      licence: string | null;
      attributionHtml: string | null;
      /** `extmetadata.Restrictions` (personality rights, trademarks, …): any value skips the file. */
      restrictions: string | null;
    }
  | { file: string; state: 'invalid'; code: ImageInfoCode };

export type ParseImageInfo = { ok: true; results: ImageInfoResult[] } | { ok: false; code: 'commons_bad_response' };

const Meta = z.object({ value: z.unknown() }).loose();
const Info = z.object({
  thumburl: z.string().max(2000),
  sha1: z.string().regex(/^[0-9a-f]{40}$/),
  mime: z.string().min(1).max(100),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  extmetadata: z.record(z.string(), Meta).optional(),
});
const Page = z.object({
  title: z.string().min(1).max(400),
  missing: z.boolean().optional(),
  imageinfo: z.array(z.unknown()).optional(),
});
const Answer = z.object({
  query: z.object({
    normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    pages: z.array(z.unknown()),
  }),
});

/** MediaWiki's title key: spaces for underscores, trimmed, first letter upper-case. */
function canon(title: string): string {
  const t = title.replaceAll('_', ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function metaText(meta: Record<string, { value?: unknown }> | undefined, key: string): string | null {
  const v = meta?.[key]?.value;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** One result per requested file name, in request order. */
export function parseImageInfo(json: unknown, requested: readonly string[]): ParseImageInfo {
  const bad = { ok: false, code: 'commons_bad_response' } as const;
  const answer = Answer.safeParse(json);
  if (!answer.success) return bad;
  const { normalized = [], redirects = [], pages } = answer.data.query;
  const map = new Map<string, string>();
  for (const { from, to } of [...normalized, ...redirects]) map.set(canon(from), canon(to));
  const byTitle = new Map<string, unknown>();
  for (const page of pages) {
    const title = (page as { title?: unknown } | null)?.title;
    if (typeof title === 'string') byTitle.set(canon(title), page);
  }

  const results = requested.map((file): ImageInfoResult => {
    const invalid = (code: ImageInfoCode): ImageInfoResult => ({ file, state: 'invalid', code });
    let title = canon(`File:${file}`);
    for (let hops = 0; hops < 3; hops++) {
      const next = map.get(title);
      if (next === undefined) break;
      title = next;
    }
    const raw = byTitle.get(title);
    const page = Page.safeParse(raw);
    if (!page.success) return invalid('commons_bad_response');
    if (page.data.missing === true) return { file, state: 'missing' };
    const info = Info.safeParse(page.data.imageinfo?.[0]);
    if (!info.success) return invalid('commons_bad_response');
    const { thumburl, sha1, mime, width, height, extmetadata } = info.data;
    const thumb = URL.canParse(thumburl) ? new URL(thumburl) : undefined;
    // The recorded answers name thumbnails on thumb.wikimedia.org (the same path is served by upload.wikimedia.org,
    // the only download host of the worker) and add utm_* parameters: we keep the path, drop the query.
    if (
      thumb === undefined ||
      thumb.protocol !== 'https:' ||
      !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(thumb.hostname) ||
      thumb.port !== '' ||
      thumb.username !== '' ||
      thumb.password !== ''
    ) {
      return invalid('commons_bad_url');
    }
    return {
      file,
      state: 'present',
      sha1,
      mime,
      width,
      height,
      thumbUrl: `https://upload.wikimedia.org${thumb.pathname}`,
      licence: metaText(extmetadata, 'License'),
      attributionHtml: metaText(extmetadata, 'Attribution') ?? metaText(extmetadata, 'Artist'),
      restrictions: metaText(extmetadata, 'Restrictions'),
    };
  });
  return { ok: true, results };
}
