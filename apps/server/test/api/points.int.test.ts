import { MuseumPoints } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSweep, type Sweep, V1, walk } from './sweep.ts';

// GET /museums/points: the ids are those of paging through GET /museums with the same filters, minus
// the museums without coordinates.

let s: Sweep;
beforeAll(async () => {
  s = await openSweep();
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const combos: Record<string, string>[] = [
  {},
  { province: 'NL-NH' },
  { category: 'art' },
  { mk: 'participating' },
  { province: 'NL-NH', mk: 'participating', category: 'art' },
  { q: 'kunst' },
  { q: 'rijksmuseum' },
  { q: 'rijksmuzeum' },
];

describe('GET /museums/points', () => {
  it.each(combos)('matches the list for %o', async (params) => {
    const r = await s.req(`${V1}/museums/points?${new URLSearchParams(params)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
    const { items } = MuseumPoints.parse(await r.json());
    const listed = (await walk(s, params)).filter((i) => i.lat !== null && i.lon !== null);
    expect(items.map((i) => i.id).sort()).toEqual(listed.map((i) => i.id).sort());
    expect(items.map((i) => i.id)).toEqual(items.map((i) => i.id).sort());
    for (const i of items) {
      const l = listed.find((x) => x.id === i.id);
      expect(i).toEqual({
        id: l?.id,
        slug: l?.slug,
        name: l?.name,
        lat: l?.lat,
        lon: l?.lon,
        museumkaart_status: l?.museumkaart_status,
        categories: l?.categories,
      });
    }
  });

  it('the unfiltered answer is non-trivial and its size is reported', async () => {
    const r = await s.req(`${V1}/museums/points`);
    const text = await r.text();
    console.info(`points bytes: ${Buffer.byteLength(text)}`);
    expect(MuseumPoints.parse(JSON.parse(text)).items.length).toBeGreaterThan(1000);
  });

  it('limit, cursor, sort and unknown parameters are 400', async () => {
    for (const p of ['limit=5', 'cursor=abc', 'sort=name', 'zzmark=1']) {
      const r = await s.req(`${V1}/museums/points?${p}`);
      expect(r.status, p).toBe(400);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      await r.arrayBuffer();
    }
  });
});
