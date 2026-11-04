import { ErrorBody } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSweep, type RouteRow, report, routeRows, type Sweep, V1 } from './sweep.ts';

// P1b criterion 4 (second half): strict parameters on every route. A value that was sent never comes back.

const MARK = 'zzmark';

let s: Sweep;
let rows: RouteRow[];
let started = 0;

beforeAll(async () => {
  s = await openSweep();
  rows = routeRows(s.cat);
  started = performance.now();
}, 120_000);
afterAll(async () => {
  if (s !== undefined) report('params', s, started);
  await s?.close();
});

const withQuery = (r: RouteRow, extra: string) => `${r.path}?${[r.valid, extra].filter((x) => x !== '').join('&')}`;

/** A 400 whose body is exactly `{"error":"bad_request","fields":<fields>}` and quotes nothing that was sent. */
async function expectBad(r: Response, fields: string[], label: string) {
  expect(r.status, label).toBe(400);
  expect(r.headers.get('cache-control'), label).toBe('private, no-store');
  const text = await r.text();
  expect(text, label).not.toContain(MARK);
  expect(ErrorBody.parse(JSON.parse(text)), label).toEqual({ error: 'bad_request', fields });
}

describe('unknown and repeated parameters', () => {
  it('an unknown parameter is a 400 with no fields, on every route', async () => {
    for (const row of rows) {
      for (const extra of [`${MARK}=1`, `a=${MARK}`, '__proto__=1', 'constructor=1']) {
        await expectBad(await s.req(withQuery(row, extra)), [], `${row.name} ${extra}`);
      }
    }
  });

  it('a repeated parameter is a 400 naming it when the route knows it', async () => {
    for (const row of rows) {
      for (const name of row.known) {
        await expectBad(await s.req(`${row.path}?${name}=1&${name}=2`), [name], `${row.name} ${name}`);
      }
      // Repeated and unknown: 400 and no field.
      await expectBad(await s.req(withQuery(row, `${MARK}=1&${MARK}=2`)), [], `${row.name} repeated unknown`);
    }
  });
});

describe('q', () => {
  const cp = (n: number) => '𝒜'.repeat(n); // one code point, two UTF-16 units

  it('100 code points answer 200 and 101 are a 400 naming q, on /museums and /museums/suggest', async () => {
    for (const path of [`${V1}/museums`, `${V1}/museums/suggest`]) {
      const ok = await s.req(`${path}?${new URLSearchParams({ q: cp(100) })}`);
      expect(ok.status, path).toBe(200);
      await ok.arrayBuffer();
      const ascii = await s.req(`${path}?${new URLSearchParams({ q: 'a'.repeat(100) })}`);
      expect(ascii.status, path).toBe(200);
      await ascii.arrayBuffer();
      await expectBad(await s.req(`${path}?${new URLSearchParams({ q: `${MARK}${cp(95)}` })}`), ['q'], path);
      await expectBad(await s.req(`${path}?${new URLSearchParams({ q: cp(101) })}`), ['q'], path);
      await expectBad(await s.req(`${path}?${new URLSearchParams({ q: 'a'.repeat(1001) })}`), ['q'], path);
      await expectBad(await s.req(`${path}?q=`), ['q'], path);
      await expectBad(await s.req(`${path}?q=%20%20`), ['q'], path);
      await expectBad(await s.req(`${path}?q=${MARK}%01`), ['q'], path);
    }
  });

  it('suggest without q is a 400 naming q', async () => {
    await expectBad(await s.req(`${V1}/museums/suggest`), ['q'], 'suggest no q');
  });
});

describe('slug', () => {
  const bad = [
    `Bad_Slug${MARK}`,
    `-x${MARK}`,
    `x${MARK}-`,
    `a--b${MARK}`,
    `a${MARK}`.padEnd(121, 'a').toLowerCase() + MARK,
    `%2e%2e`,
    `a%2F${MARK}`,
    `%2F${MARK}`,
    `${MARK}%00`,
    `${MARK}%ZZ`,
    `${MARK}%C3%A9`,
    `${MARK}%20x`,
  ];
  it('a bad slug is a 400 naming slug, or a 404, never a 500, and the value is not echoed', async () => {
    for (const slug of bad) {
      const r = await s.req(`${V1}/museums/${slug}`);
      expect([400, 404], slug).toContain(r.status);
      expect(r.headers.get('cache-control'), slug).toBe('private, no-store');
      const text = await r.text();
      expect(text, slug).not.toContain(MARK);
      const body = ErrorBody.parse(JSON.parse(text));
      if (r.status === 400) expect(body, slug).toEqual({ error: 'bad_request', fields: ['slug'] });
      else expect(body, slug).toEqual({ error: 'not_found' });
    }
  });

  it('120 characters pass the parser (404, not 400) and 121 do not', async () => {
    const r120 = await s.req(`${V1}/museums/${'a'.repeat(120)}`);
    expect(r120.status).toBe(404);
    await r120.arrayBuffer();
    await expectBad(await s.req(`${V1}/museums/${'a'.repeat(121)}`), ['slug'], '121');
  });
});

describe('bad values', () => {
  // [parameter, values]: each value fails exactly that parameter. `$` is replaced by the marker.
  const list: Array<[string, string[]]> = [
    ['limit', ['0', '51', 'abc$', '-1', '1.5', '01', '1e1$', '%20']],
    ['province', ['NL-XX$', 'nl-nh$', 'NH$', '']],
    ['category', ['foo$', 'ART$', '']],
    ['mk', ['left$', 'unknown$', 'true$', '']],
    ['sort', ['random$', 'RANK$', '']],
    ['municipality', ['0363$', 'GM363$', 'gm0363$', 'GM03633$', '']],
    ['cursor', ['$', '!!$', 'a$.b', `${'a'.repeat(4097)}$`, '']],
  ];

  it('/museums: each bad value names exactly its parameter', async () => {
    for (const [name, values] of list) {
      for (const v of values) {
        const value = v.replaceAll('$', MARK);
        await expectBad(
          await s.req(`${V1}/museums?${name}=${encodeURIComponent(value)}`),
          [name],
          `${name}=${value.slice(0, 40)}`,
        );
      }
    }
  });

  it('a bad value names only its own parameter next to good ones', async () => {
    await expectBad(await s.req(`${V1}/museums?province=NL-NH&limit=0${MARK}&sort=name`), ['limit'], 'mixed');
    await expectBad(await s.req(`${V1}/museums?province=NL-XX${MARK}&limit=0${MARK}`), ['limit', 'province'], 'two');
  });

  it('/museums/near: coordinates', async () => {
    const lat: string[] = ['52.1234$', '52.12345$', '49.999', '53.701', '90', '-52.1', 'x$', '', '52.$', '5.2e1$'];
    const lon: string[] = ['5.1234$', '3.199', '7.301', '180', '-5.1', 'x$', '', '5.$'];
    for (const v of lat) {
      const value = v.replaceAll('$', MARK);
      await expectBad(
        await s.req(`${V1}/museums/near?lat=${encodeURIComponent(value)}&lon=5.100`),
        ['lat'],
        `lat=${value}`,
      );
    }
    for (const v of lon) {
      const value = v.replaceAll('$', MARK);
      await expectBad(
        await s.req(`${V1}/museums/near?lat=52.100&lon=${encodeURIComponent(value)}`),
        ['lon'],
        `lon=${value}`,
      );
    }
    await expectBad(await s.req(`${V1}/museums/near`), ['lat', 'lon'], 'none');
    await expectBad(await s.req(`${V1}/museums/near?lon=5.100`), ['lat'], 'no lat');
    await expectBad(await s.req(`${V1}/museums/near?lat=52.100`), ['lon'], 'no lon');
    for (const v of ['0', '51', 'abc$']) {
      const value = v.replaceAll('$', MARK);
      await expectBad(
        await s.req(`${V1}/museums/near?lat=52.100&lon=5.100&limit=${value}`),
        ['limit'],
        `limit=${value}`,
      );
    }
  });

  it('the NL box edges and three decimals are accepted', async () => {
    for (const q of [
      'lat=50.700&lon=3.200',
      'lat=53.700&lon=7.300',
      'lat=52.1&lon=5',
      'lat=52.123&lon=5.999&limit=50',
    ]) {
      const r = await s.req(`${V1}/museums/near?${q}`);
      expect(r.status, q).toBe(200);
      await r.arrayBuffer();
    }
  });

  it('a cursor of the right alphabet but no meaning is a 400 naming cursor', async () => {
    for (const c of ['AAAA', 'e30', 'eyJ4IjoxfQ', 'abc_-']) {
      await expectBad(await s.req(`${V1}/museums?cursor=${c}${MARK}`), ['cursor'], c);
    }
  });
});
