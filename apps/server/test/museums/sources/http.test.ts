import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../../test/msw.setup.ts';
import {
  ALLOWED_HOSTS,
  allowedUrl,
  BACKOFF_MS,
  fetchJson,
  type HttpDeps,
  REPO_URL,
  RETRY_AFTER_CAP_MS,
  retryWaitMs,
  userAgent,
  validContact,
} from '../../../src/museums/sources/http.ts';
import { fetchRce, rceUrl } from '../../../src/museums/sources/rce.ts';
import { SOURCE_ERROR_CODES } from '../../../src/museums/sources/types.ts';
import {
  fetchWikidata,
  fetchWikidataAll,
  parseWikidata,
  WIKIDATA_BATCH,
  WIKIDATA_PAUSE_MS,
  wikidataItemsQuery,
  wikidataQuery,
} from '../../../src/museums/sources/wikidata.ts';

const WD = 'https://query.wikidata.org/sparql';
const RCE = 'https://services.rce.geovoorziening.nl/some/path';
// Negative cases: hosts the sync must never fetch (listed in test/forbidden-hosts.test.ts).
const MUSEUM_NL = 'https://www.museum.nl/nl/museum/x';
const OSM = 'https://www.openstreetmap.org/api/0.6/map';

const NOW = Date.parse('2026-11-01T12:00:00Z');

/** Deps that never sleep: the waits are recorded. */
function deps(extra: HttpDeps = {}): HttpDeps & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    now: () => NOW,
    ...extra,
  };
}

const json = (body: unknown = { ok: true }) => HttpResponse.json(body as Record<string, unknown>);
const limited = (status: number, retryAfter?: string) =>
  new HttpResponse('slow down SECRET-BODY', {
    status,
    ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
  });

describe('allowlist', () => {
  it('is frozen and holds exactly the two source hosts', () => {
    expect([...ALLOWED_HOSTS]).toEqual(['query.wikidata.org', 'services.rce.geovoorziening.nl']);
    expect(Object.isFrozen(ALLOWED_HOSTS)).toBe(true);
  });

  it.each([
    ['the link-out host', MUSEUM_NL],
    ['an OpenStreetMap host', OSM],
    ['plain http', 'http://query.wikidata.org/sparql'],
    ['a port', 'https://query.wikidata.org:8443/sparql'],
    ['credentials', 'https://user:pw@query.wikidata.org/sparql'],
    ['a user name only', 'https://user@query.wikidata.org/sparql'],
    ['a sub-domain', 'https://evil.query.wikidata.org/sparql'],
    ['a look-alike prefix', 'https://query.wikidata.org.example.com/sparql'],
    ['a trailing dot', 'https://query.wikidata.org./sparql'],
    ['a Commons host', 'https://commons.wikimedia.org/w/api.php'],
    ['another scheme', 'ftp://query.wikidata.org/sparql'],
    ['text that is not a URL', 'not a url'],
    ['an empty string', ''],
  ])('refuses %s before any request is made', async (_label, url) => {
    let requests = 0;
    server.use(
      http.all('*', () => {
        requests++;
        return json();
      }),
    );
    expect(allowedUrl(url)).toBeUndefined();
    expect(await fetchJson(url, {}, deps())).toEqual({ ok: false, code: 'host_not_allowed' });
    expect(requests).toBe(0);
  });

  it('allows the two hosts over https (the default port is no port)', () => {
    expect(allowedUrl(WD)?.hostname).toBe('query.wikidata.org');
    expect(allowedUrl(RCE)?.hostname).toBe('services.rce.geovoorziening.nl');
    expect(allowedUrl('https://query.wikidata.org:443/sparql')?.hostname).toBe('query.wikidata.org');
    expect(allowedUrl('HTTPS://QUERY.WIKIDATA.ORG/sparql')?.hostname).toBe('query.wikidata.org');
  });
});

describe('User-Agent', () => {
  it('is exact, and the contact replaces the repository URL only when valid', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(RCE, ({ request }) => {
        seen.push(request.headers.get('user-agent'));
        return json();
      }),
    );
    await fetchJson(RCE, {}, deps());
    await fetchJson(RCE, {}, deps({ contact: 'https://example.org/about-this-sync' }));
    await fetchJson(RCE, {}, deps({ contact: 'sync-owner@example.org' }));
    await fetchJson(RCE, {}, deps({ contact: 'not valid <script>' }));
    await fetchJson(RCE, {}, deps({ contact: 'javascript:alert(1)' }));
    expect(seen).toEqual([
      `mjk-museum-sync/1.0 (+${REPO_URL})`,
      'mjk-museum-sync/1.0 (+https://example.org/about-this-sync)',
      'mjk-museum-sync/1.0 (+sync-owner@example.org)',
      `mjk-museum-sync/1.0 (+${REPO_URL})`,
      `mjk-museum-sync/1.0 (+${REPO_URL})`,
    ]);
    expect(REPO_URL).toBe('https://github.com/mwijkhuisen/Museumjaarkaart');
  });

  it('validates the contact', () => {
    expect(validContact('https://example.org/x')).toBe(true);
    expect(validContact('a@b.c')).toBe(true);
    expect(validContact(`https://example.org/${'x'.repeat(200)}`)).toBe(false);
    expect(validContact('x'.repeat(201))).toBe(false);
    expect(validContact(`${'x'.repeat(180)}@example.org`)).toBe(true);
    expect(validContact('http://example.org/')).toBe(false);
    expect(validContact('https://exa mple.org')).toBe(false);
    expect(validContact('https://example.org/\nX-Evil: 1')).toBe(false);
    expect(validContact('me@example.org\r\nX-Evil: 1')).toBe(false);
    expect(validContact('<a@b.c>')).toBe(false);
    expect(validContact('(a@b.c)')).toBe(false);
    expect(validContact('a@@b.c')).toBe(false);
    expect(validContact('bé@example.org')).toBe(false);
    expect(validContact('')).toBe(false);
    expect(validContact(undefined)).toBe(false);
    expect(userAgent('nope')).toBe(`mjk-museum-sync/1.0 (+${REPO_URL})`);
  });

  it('cannot be replaced by the caller', async () => {
    let seen: string | null = null;
    server.use(
      http.get(RCE, ({ request }) => {
        seen = request.headers.get('user-agent');
        return json();
      }),
    );
    await fetchJson(RCE, { headers: { 'User-Agent': 'evil/1' } }, deps());
    expect(seen).toBe(userAgent());
  });
});

describe('rate limits', () => {
  it('waits Retry-After in seconds on a 429, then succeeds', async () => {
    let calls = 0;
    server.use(http.get(RCE, () => (++calls === 1 ? limited(429, '2') : json({ n: calls }))));
    const d = deps();
    const r = await fetchJson(RCE, {}, d);
    expect(r).toMatchObject({ ok: true, body: { n: 2 } });
    expect(d.waits).toEqual([2000]);
    expect(calls).toBe(2);
  });

  it('waits until an HTTP date', async () => {
    let calls = 0;
    server.use(http.get(RCE, () => (++calls === 1 ? limited(429, 'Sun, 01 Nov 2026 12:01:30 GMT') : json())));
    const d = deps();
    expect((await fetchJson(RCE, {}, d)).ok).toBe(true);
    expect(d.waits).toEqual([90_000]);
  });

  it('never waits for a date in the past', () => {
    expect(retryWaitMs('Sun, 01 Nov 2026 11:00:00 GMT', 1, NOW)).toBe(0);
    expect(retryWaitMs('0', 1, NOW)).toBe(0);
  });

  it('caps Retry-After at 10 minutes', async () => {
    let calls = 0;
    server.use(http.get(RCE, () => (++calls === 1 ? limited(429, '99999') : json())));
    const d = deps();
    await fetchJson(RCE, {}, d);
    expect(d.waits).toEqual([600_000]);
    expect(RETRY_AFTER_CAP_MS).toBe(600_000);
    expect(retryWaitMs('Mon, 01 Nov 2027 12:00:00 GMT', 1, NOW)).toBe(600_000);
    expect(retryWaitMs('99999999999999999999', 1, NOW)).toBe(600_000);
  });

  it('backs off 30 s, then 60 s, without a usable Retry-After', async () => {
    let calls = 0;
    server.use(http.get(RCE, () => (++calls < 3 ? limited(429, calls === 1 ? undefined : 'garbage') : json())));
    const d = deps();
    expect((await fetchJson(RCE, {}, d)).ok).toBe(true);
    expect(d.waits).toEqual([30_000, 60_000]);
    expect(BACKOFF_MS).toEqual([30_000, 60_000]);
  });

  it('gives up with rate_limited after exactly 3 requests', async () => {
    let calls = 0;
    server.use(
      http.get(RCE, () => {
        calls++;
        return limited(429, '1');
      }),
    );
    const d = deps();
    const r = await fetchJson(RCE, {}, d);
    expect(r).toEqual({ ok: false, code: 'rate_limited' });
    expect(calls).toBe(3);
    expect(d.waits).toEqual([1000, 1000]);
    expect(JSON.stringify(r)).not.toContain('SECRET-BODY');
  });

  it('treats 503 like 429', async () => {
    let calls = 0;
    server.use(http.get(RCE, () => (++calls === 1 ? limited(503, '3') : json())));
    const d = deps();
    expect((await fetchJson(RCE, {}, d)).ok).toBe(true);
    expect(d.waits).toEqual([3000]);

    let always = 0;
    server.use(
      http.get(RCE, () => {
        always++;
        return limited(503);
      }),
    );
    const e = deps();
    expect(await fetchJson(RCE, {}, e)).toEqual({ ok: false, code: 'rate_limited' });
    expect(always).toBe(3);
    expect(e.waits).toEqual([30_000, 60_000]);
  });

  it('does not retry any other status', async () => {
    let calls = 0;
    server.use(
      http.get(RCE, () => {
        calls++;
        return new HttpResponse('boom SECRET-BODY', { status: 500 });
      }),
    );
    const d = deps();
    const r = await fetchJson(RCE, {}, d);
    expect(r).toEqual({ ok: false, code: 'http_status' });
    expect(calls).toBe(1);
    expect(d.waits).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('SECRET-BODY');
  });
});

describe('redirects', () => {
  it('maps a 302 to redirect and never requests the target', async () => {
    let targets = 0;
    server.use(
      http.get(
        RCE,
        () => new HttpResponse(null, { status: 302, headers: { Location: 'https://query.wikidata.org/x' } }),
      ),
      http.get('https://query.wikidata.org/x', () => {
        targets++;
        return json();
      }),
    );
    expect(await fetchJson(RCE, {}, deps())).toEqual({ ok: false, code: 'redirect' });
    expect(targets).toBe(0);
  });

  it.each([301, 303, 307, 308])('maps a %i to redirect, also towards a host that is not allowed', async (status) => {
    let targets = 0;
    server.use(
      http.get(RCE, () => new HttpResponse(null, { status, headers: { Location: OSM } })),
      http.get(OSM, () => {
        targets++;
        return json();
      }),
    );
    expect(await fetchJson(RCE, {}, deps())).toEqual({ ok: false, code: 'redirect' });
    expect(targets).toBe(0);
  });
});

describe('size and time', () => {
  it('refuses a body over maxBytes without a Content-Length', async () => {
    server.use(http.get(RCE, () => HttpResponse.text('x'.repeat(5000))));
    expect(await fetchJson(RCE, {}, deps({ maxBytes: 1000 }))).toEqual({ ok: false, code: 'too_large' });
  });

  it('refuses a body over maxBytes that declares its size', async () => {
    server.use(http.get(RCE, () => new HttpResponse('x'.repeat(5000), { headers: { 'Content-Length': '5000' } })));
    expect(await fetchJson(RCE, {}, deps({ maxBytes: 1000 }))).toEqual({ ok: false, code: 'too_large' });
  });

  it('refuses a streamed body that grows past maxBytes', async () => {
    server.use(
      http.get(RCE, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
            controller.close();
          },
        });
        return new HttpResponse(stream);
      }),
    );
    expect(await fetchJson(RCE, {}, deps({ maxBytes: 1000 }))).toEqual({ ok: false, code: 'too_large' });
  });

  it('accepts a body of exactly maxBytes', async () => {
    const body = JSON.stringify({ a: 1 });
    server.use(http.get(RCE, () => new HttpResponse(body)));
    const r = await fetchJson(RCE, {}, deps({ maxBytes: body.length }));
    expect(r).toMatchObject({ ok: true, body: { a: 1 }, bytes: body.length });
  });

  it('times out a slow answer', async () => {
    server.use(
      http.get(RCE, async () => {
        await delay(2000);
        return json();
      }),
    );
    expect(await fetchJson(RCE, {}, deps({ timeoutMs: 30 }))).toEqual({ ok: false, code: 'timeout' });
  });

  it('maps a failing connection to network', async () => {
    server.use(http.get(RCE, () => HttpResponse.error()));
    expect(await fetchJson(RCE, {}, deps())).toEqual({ ok: false, code: 'network' });
  });

  it('maps a throwing fetch to network, without its message', async () => {
    const failing = async () => {
      throw new Error('SECRET-BODY https://secret.example/');
    };
    const r = await fetchJson(RCE, {}, deps({ fetch: failing as unknown as typeof fetch }));
    expect(r).toEqual({ ok: false, code: 'network' });
  });
});

describe('answers', () => {
  it('returns the parsed body, the size and the time', async () => {
    let t = 1000;
    server.use(http.get(RCE, () => json({ a: [1, 2] })));
    const r = await fetchJson(RCE, {}, deps({ now: () => (t += 7) }));
    expect(r).toMatchObject({ ok: true, body: { a: [1, 2] }, bytes: 11 });
    expect(r.ok && r.ms).toBe(7);
  });

  it('maps a body that is not JSON to not_json, without the text', async () => {
    server.use(http.get(RCE, () => new HttpResponse('<html>SECRET-BODY</html>')));
    const r = await fetchJson(RCE, {}, deps());
    expect(r).toEqual({ ok: false, code: 'not_json' });
    expect(JSON.stringify(r)).not.toContain('SECRET-BODY');
  });

  it('maps an empty body and invalid UTF-8 to not_json', async () => {
    server.use(http.get(RCE, () => new HttpResponse(null, { status: 200 })));
    expect(await fetchJson(RCE, {}, deps())).toEqual({ ok: false, code: 'not_json' });
    server.use(http.get(RCE, () => new HttpResponse(new Uint8Array([0x22, 0xff, 0xfe, 0x22]))));
    expect(await fetchJson(RCE, {}, deps())).toEqual({ ok: false, code: 'not_json' });
  });

  it.each([400, 401, 403, 404, 500, 502])('maps a %i to http_status', async (status) => {
    server.use(http.get(RCE, () => new HttpResponse('SECRET-BODY', { status })));
    const r = await fetchJson(RCE, {}, deps());
    expect(r).toEqual({ ok: false, code: 'http_status' });
    expect(JSON.stringify(r)).not.toContain('SECRET-BODY');
  });

  it('only ever returns a fixed code', async () => {
    server.use(http.get(RCE, () => new HttpResponse('nope', { status: 418 })));
    const r = await fetchJson(RCE, {}, deps());
    expect(r.ok === false && (SOURCE_ERROR_CODES as readonly string[]).includes(r.code)).toBe(true);
  });
});

describe('the source requests', () => {
  it('POSTs the Wikidata query form-encoded, with the SPARQL JSON Accept header', async () => {
    let seen: { method: string; type: string | null; accept: string | null; body: string } | undefined;
    server.use(
      http.post(WD, async ({ request }) => {
        seen = {
          method: request.method,
          type: request.headers.get('content-type'),
          accept: request.headers.get('accept'),
          body: await request.text(),
        };
        return json({ head: { vars: [] }, results: { bindings: [] } });
      }),
    );
    const query = wikidataQuery({ qids: ['Q1', 'Q22'] });
    const r = await fetchWikidata(query, deps());
    expect(r.ok).toBe(true);
    expect(seen?.method).toBe('POST');
    expect(seen?.type).toBe('application/x-www-form-urlencoded');
    expect(seen?.accept).toBe('application/sparql-results+json');
    expect(new URLSearchParams(seen?.body).get('query')).toBe(query);
    expect(seen?.body.startsWith('query=')).toBe(true);
  });

  it('GETs the RCE features with one WFS 2.0 GetFeature request', async () => {
    let seen: URL | undefined;
    let accept: string | null = null;
    server.use(
      http.get('https://services.rce.geovoorziening.nl/*', ({ request }) => {
        seen = new URL(request.url);
        accept = request.headers.get('accept');
        return json({ type: 'FeatureCollection', features: [] });
      }),
    );
    expect((await fetchRce(deps())).ok).toBe(true);
    expect(seen?.hostname).toBe('services.rce.geovoorziening.nl');
    expect(seen?.pathname.endsWith('/wfs')).toBe(true);
    expect(Object.fromEntries(seen?.searchParams ?? [])).toEqual({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: expect.stringMatching(/:overzichtmusea$/),
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
    });
    expect(accept).toBe('application/json');
    expect(allowedUrl(rceUrl())).toBeDefined();
  });
});

describe('the batched Wikidata fetch (A§7.1)', () => {
  const ENTITY = 'http://www.wikidata.org/entity/';
  const qids = Array.from({ length: 450 }, (_, i) => `Q${1000 + i}`);
  const valuesOf = (query: string): string[] => {
    const m = /VALUES \?item \{ ([^}]*) \}/.exec(query);
    return m?.[1]?.split(' ').map((v) => v.replace('wd:', '')) ?? [];
  };
  /** Answers the item list with `list`, and each batch with one labelled binding per QID in its VALUES. */
  const wdqs = (list: string[], seen: string[][], fail?: number) =>
    http.post(WD, async ({ request }) => {
      const query = new URLSearchParams(await request.text()).get('query') ?? '';
      if (!query.includes('VALUES ?item')) {
        seen.push([]);
        return json({
          head: { vars: ['item'] },
          results: { bindings: list.map((q) => ({ item: { type: 'uri', value: `${ENTITY}${q}` } })) },
        });
      }
      const batch = valuesOf(query);
      seen.push(batch);
      if (fail !== undefined && seen.length - 1 === fail)
        return new HttpResponse('upstream request timeout', { status: 504 });
      return json({
        head: { vars: ['item', 'labelNl'] },
        results: {
          bindings: batch.map((q) => ({
            item: { type: 'uri', value: `${ENTITY}${q}` },
            labelNl: { type: 'literal', value: `Museum ${q}` },
          })),
        },
      });
    });

  it("the item list is the query's own item set, with nothing per item", () => {
    const items = wikidataItemsQuery();
    expect(items.match(/\bSELECT\b/g)).toHaveLength(1);
    expect(items).toContain('SELECT DISTINCT ?item WHERE {\n    hint:Query hint:optimizer "None" .');
    expect(items).toContain('?class wdt:P279* wd:Q33506 .');
    expect(items).toContain('FILTER(!BOUND(?up1) && !BOUND(?up2) && !BOUND(?up3))');
    expect(items).not.toMatch(/INCLUDE|UNION|GROUP BY|@@MJK_VALUES@@/);
    for (const prefix of ['hint:', 'wd:', 'wdt:']) expect(items).toContain(`PREFIX ${prefix}`);
  });

  it('fetches the item list, then the details in batches with a pause before each, and merges them', async () => {
    const seen: string[][] = [];
    server.use(wdqs(qids, seen));
    const d = deps();
    const r = await fetchWikidataAll(d);
    expect(r.ok).toBe(true);
    // One list, then ceil(450 / 200) = 3 batches of at most 200, each item exactly once, in QID order.
    expect(seen.map((b) => b.length)).toEqual([0, WIKIDATA_BATCH, WIKIDATA_BATCH, 50]);
    expect(seen.flat()).toEqual(qids);
    expect(d.waits).toEqual([WIKIDATA_PAUSE_MS, WIKIDATA_PAUSE_MS, WIKIDATA_PAUSE_MS]);
    if (!r.ok) return;
    const parsed = parseWikidata(r.body);
    expect(parsed.ok && parsed.rows.length).toBe(450);
  });

  it('a failed batch fails the whole fetch with its code: no partial answer', async () => {
    server.use(wdqs(qids, [], 2));
    expect(await fetchWikidataAll(deps())).toEqual({ ok: false, code: 'http_status' });
  });

  it('an empty list makes no detail request; a malformed list goes to the parser as it is', async () => {
    const seen: string[][] = [];
    server.use(wdqs([], seen));
    const empty = await fetchWikidataAll(deps());
    expect(seen).toEqual([[]]);
    expect(empty.ok && parseWikidata(empty.body)).toEqual({ ok: true, rows: [], invalid: {}, notes: {} });
    server.use(http.post(WD, () => json({ nope: true })));
    const bad = await fetchWikidataAll(deps());
    expect(bad.ok && parseWikidata(bad.body)).toEqual({ ok: false, code: 'schema' });
  });
});
