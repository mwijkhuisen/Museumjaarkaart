import { readFileSync } from 'node:fs';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../../test/msw.setup.ts';
import { imageInfoUrl, parseImageInfo, THUMB_WIDTH } from '../../../src/museums/commons/api.ts';
import { fetchJson } from '../../../src/museums/sources/http.ts';
import { FIXTURE_DIR } from '../sources/golden.ts';

const load = (name: string) => JSON.parse(readFileSync(`${FIXTURE_DIR}commons/${name}.json`, 'utf8')) as unknown;
const titles = (json: unknown) =>
  (json as { query: { pages: { title: string }[] } }).query.pages.map((p) => p.title.replace(/^File:/, ''));

describe('imageInfoUrl', () => {
  it('builds the one Commons request', () => {
    const url = new URL(imageInfoUrl(['A b.jpg', 'C.png']));
    expect(url.origin + url.pathname).toBe('https://commons.wikimedia.org/w/api.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'imageinfo',
      iiprop: 'url|sha1|size|mime|extmetadata',
      iiurlwidth: String(THUMB_WIDTH),
      iiextmetadatafilter: 'License|LicenseShortName|Artist|Attribution|Restrictions',
      titles: 'File:A b.jpg|File:C.png',
    });
  });

  it.each([
    [[]],
    [Array.from({ length: 51 }, (_, i) => `f${i}.jpg`)],
    [['a|b.jpg']],
    [['a/b.jpg']],
    [['']],
    [['x'.repeat(256)]],
    [['a\nb']],
    [['a#b']],
    [['<a>']],
  ])('refuses %j', (files) => {
    expect(() => imageInfoUrl(files)).toThrow(RangeError);
  });

  it('accepts 50 names', () => {
    expect(() => imageInfoUrl(Array.from({ length: 50 }, (_, i) => `f${i}.jpg`))).not.toThrow();
  });
});

describe('parseImageInfo: the recorded answer', () => {
  const json = load('normal');
  const requested = titles(json);
  const parsed = parseImageInfo(json, requested);

  it('gives one present result per file, in request order, with thumbnails on upload.wikimedia.org', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.results.map((r) => r.file)).toEqual(requested);
    for (const r of parsed.results) {
      expect(r.state).toBe('present');
      if (r.state !== 'present') continue;
      expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(r.thumbUrl).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[^?#]+$/);
      expect(r.licence).not.toBeNull();
      expect(r.width).toBeGreaterThan(0);
    }
  });

  it('takes Attribution over Artist', () => {
    if (!parsed.ok) throw new Error('parse');
    const withAttribution = parsed.results.find((r) => r.file === 'Arsenaal Miniatuur Walcheren.JPG');
    const raw = (
      json as { query: { pages: { title: string; imageinfo: { extmetadata: Record<string, { value: string }> }[] }[] } }
    ).query.pages.find((p) => p.title === 'File:Arsenaal Miniatuur Walcheren.JPG')?.imageinfo[0]?.extmetadata;
    expect(withAttribution).toMatchObject({ attributionHtml: raw?.Attribution?.value });
  });
});

describe('parseImageInfo: the synthetic answer', () => {
  const json = load('synthetic');
  const requested = [
    'Missing.jpg',
    'Nc.jpg',
    'Gfdl.jpg',
    'Nolicence.jpg',
    'NoAuthor.jpg',
    'Hostile.jpg',
    'Elsewhere.jpg',
    'my_file.jpg',
    'Absent.jpg',
  ];
  const parsed = parseImageInfo(json, requested);
  const byFile = (file: string) => (parsed.ok ? parsed.results.find((r) => r.file === file) : undefined);

  it('reports a missing file', () => {
    expect(byFile('Missing.jpg')).toEqual({ file: 'Missing.jpg', state: 'missing' });
  });

  it('keeps the raw licence for the allowlist to judge, and null when there is none', () => {
    expect(byFile('Nc.jpg')).toMatchObject({ state: 'present', licence: 'cc-by-nc-4.0' });
    expect(byFile('Gfdl.jpg')).toMatchObject({ licence: 'gfdl' });
    expect(byFile('Nolicence.jpg')).toMatchObject({ state: 'present', licence: null });
    expect(byFile('NoAuthor.jpg')).toMatchObject({ licence: 'cc-by-4.0', attributionHtml: null });
  });

  it('passes the hostile author text through unparsed (attribution.ts reduces it)', () => {
    expect(byFile('Hostile.jpg')).toMatchObject({ attributionHtml: expect.stringContaining('<script>') });
  });

  it('refuses a thumbnail on another host', () => {
    expect(byFile('Elsewhere.jpg')).toEqual({ file: 'Elsewhere.jpg', state: 'invalid', code: 'commons_bad_url' });
  });

  it('follows a normalized title (underscore and lower-case first letter)', () => {
    expect(byFile('my_file.jpg')).toMatchObject({ state: 'present', licence: 'cc0' });
  });

  it('marks a requested file the answer does not mention as invalid, never a throw', () => {
    expect(byFile('Absent.jpg')).toEqual({ file: 'Absent.jpg', state: 'invalid', code: 'commons_bad_response' });
  });
});

describe('parseImageInfo: malformed input', () => {
  it.each([[null], ['x'], [[]], [{}], [{ query: {} }], [{ query: { pages: 'x' } }]])('%j is a typed error', (json) => {
    expect(parseImageInfo(json, ['a.jpg'])).toEqual({ ok: false, code: 'commons_bad_response' });
  });

  it.each([
    ['a short sha1', { sha1: 'abc' }],
    ['a zero width', { width: 0 }],
    ['a non-string thumburl', { thumburl: 5 }],
    ['a non-url thumburl', { thumburl: 'not a url' }],
  ])('%s makes that file invalid', (_name, over) => {
    const info = {
      thumburl: 'https://upload.wikimedia.org/x.jpg',
      sha1: 'a'.repeat(40),
      mime: 'image/jpeg',
      width: 1,
      height: 1,
      ...over,
    };
    const json = { query: { pages: [{ title: 'File:a.jpg', imageinfo: [info] }, 5, null] } };
    const r = parseImageInfo(json, ['a.jpg']);
    expect(r).toMatchObject({ ok: true, results: [{ file: 'a.jpg', state: 'invalid' }] });
  });

  it('a page without imageinfo that is not missing is invalid', () => {
    expect(parseImageInfo({ query: { pages: [{ title: 'File:a.jpg' }] } }, ['a.jpg'])).toMatchObject({
      results: [{ state: 'invalid', code: 'commons_bad_response' }],
    });
  });

  it('a redirect loop ends', () => {
    const r = {
      query: {
        redirects: [
          { from: 'File:A.jpg', to: 'File:B.jpg' },
          { from: 'File:B.jpg', to: 'File:A.jpg' },
        ],
        pages: [],
      },
    };
    expect(parseImageInfo(r, ['A.jpg'])).toMatchObject({ ok: true, results: [{ state: 'invalid' }] });
  });
});

describe('the request through the guarded client', () => {
  it('goes to Commons only, answered by a handler', async () => {
    const seen: string[] = [];
    server.use(
      http.get('https://commons.wikimedia.org/w/api.php', ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('titles') ?? '');
        return HttpResponse.json(load('synthetic') as Record<string, unknown>);
      }),
    );
    const r = await fetchJson(imageInfoUrl(['Nc.jpg']));
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['File:Nc.jpg']);
    if (r.ok) expect(parseImageInfo(r.body, ['Nc.jpg']).ok).toBe(true);
  });
});
