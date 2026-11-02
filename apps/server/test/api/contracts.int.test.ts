import { ErrorBody, MuseumDetail } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Case, cases, openSweep, report, type Sweep, V1, walk } from './sweep.ts';

// P1b criterion 4 (first half): every answer parses its contract, on the real app over the seeded catalogue.

let s: Sweep;
let table: Case[];
let started = 0;

beforeAll(async () => {
  s = await openSweep();
  table = await cases(s);
  started = performance.now();
}, 120_000);
afterAll(async () => {
  if (s !== undefined) report('contracts', s, started);
  await s?.close();
});

describe('contracts', () => {
  it('every route answers its status and parses its contract', async () => {
    for (const row of table) {
      const r = await s.req(row.path);
      expect(r.status, row.name).toBe(row.status);
      if (row.status === 301) {
        expect(await r.text(), row.name).toBe('');
        const to = r.headers.get('location');
        expect(to, row.name).toBe(`${V1}/museums/${s.cat.named.renamed.slug}`);
        const followed = await s.req(to as string);
        expect(followed.status, row.name).toBe(200);
        expect(MuseumDetail.parse(await followed.json()).id).toBe(s.cat.named.renamed.id);
        continue;
      }
      expect(r.headers.get('content-type'), row.name).toMatch(/^application\/json/);
      const body = await r.json();
      expect(row.schema?.safeParse(body).success, `${row.name}: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
    }
  });

  it('every old slug of the renamed museum redirects to a 200', async () => {
    for (const old of s.cat.named.renamed.oldSlugs) {
      const r = await s.req(`${V1}/museums/${old}`);
      expect(r.status).toBe(301);
      expect(await r.text()).toBe('');
      expect((await s.req(r.headers.get('location') as string)).status).toBe(200);
    }
  });

  it('every error body is exactly the fixed shape', async () => {
    for (const row of table.filter((x) => x.status >= 400)) {
      const body = ErrorBody.parse(await (await s.req(row.path)).json());
      expect(
        Object.keys(body).every((k) => k === 'error' || k === 'fields'),
        row.name,
      ).toBe(true);
    }
  });

  it('the whole list parses page by page, and so does every visible detail', async () => {
    const items = await walk(s);
    expect(items.length).toBe(s.cat.visibleCount);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    // Walking by name covers the same museums.
    expect((await walk(s, { sort: 'name' })).length).toBe(items.length);

    const allowed = new Set(Object.keys(MuseumDetail.shape));
    for (const item of items) {
      const r = await s.req(`${V1}/museums/${item.slug}`);
      expect(r.status, item.slug).toBe(200);
      const body = (await r.json()) as Record<string, unknown>;
      expect(MuseumDetail.safeParse(body).success, item.slug).toBe(true);
      expect(
        Object.keys(body).filter((k) => !allowed.has(k)),
        item.slug,
      ).toEqual([]);
      expect(body.id).toBe(item.id);
    }
  }, 120_000);
});
