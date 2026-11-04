import { ErrorBody, MuseumList, NearList, Provinces, Q, Suggest } from '@mjk/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSweep, report, type Sweep, V1, walk } from './sweep.ts';

// P1b criterion 7: a hidden museum is in no answer of any public route. The hidden rows are read once as
// mjk_migrator (the owner) to know their names, aliases, places and coordinates.

type Hidden = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  lat: number | null;
  lon: number | null;
  province: string | null;
  categories: string[];
  aliases: string[];
};

let s: Sweep;
let hidden: Hidden[];
let hiddenIds: Set<string>;
let hiddenSlugs: Set<string>;
let visible: MuseumList['items'];
let started = 0;

beforeAll(async () => {
  s = await openSweep();
  const owner = new pg.Client({ connectionString: s.tdb.urls.mjk_migrator });
  await owner.connect();
  try {
    const res = await owner.query<Hidden>(
      `SELECT m.id, m.slug, m.name, m.name_en, m.lat, m.lon, mu.province_code AS province, m.categories,
              COALESCE((SELECT array_agg(a.alias) FROM museum_alias a WHERE a.museum_id = m.id), '{}') AS aliases
         FROM museum m LEFT JOIN municipality mu ON mu.cbs_code = m.municipality_code
        WHERE m.hidden`,
    );
    hidden = res.rows;
  } finally {
    await owner.end();
  }
  hiddenIds = new Set(hidden.map((h) => h.id));
  hiddenSlugs = new Set(hidden.map((h) => h.slug));
  expect(hiddenIds).toEqual(new Set(s.cat.hiddenIds));
  expect(hidden.length).toBeGreaterThanOrEqual(25);
  visible = await walk(s);
  started = performance.now();
}, 120_000);
afterAll(async () => {
  if (s !== undefined) report('hidden', s, started);
  await s?.close();
});

const unaccent = (x: string) => x.normalize('NFKD').replace(/\p{M}+/gu, '');
const clip = (x: string) => [...x].slice(0, 100).join('');

/** The texts a visitor could type to find `h`: name, English name, aliases, each with and without accents. */
function queries(h: Hidden): string[] {
  const out = new Set<string>();
  for (const t of [h.name, h.name_en ?? '', ...h.aliases]) {
    for (const v of [t, unaccent(t), t.toLowerCase(), unaccent(t).toUpperCase()]) {
      const c = clip(v);
      if (Q.safeParse(c).success) out.add(c);
    }
  }
  return [...out];
}

describe('hidden museums', () => {
  it('the unfiltered walk holds none, and /provinces counts equal the walk', async () => {
    expect(visible.filter((i) => hiddenIds.has(i.id) || hiddenSlugs.has(i.slug))).toEqual([]);
    const byName = await walk(s, { sort: 'name' });
    expect(byName.filter((i) => hiddenIds.has(i.id))).toEqual([]);

    const counts = new Map<string, number>();
    for (const i of visible)
      if (i.province_code !== null) counts.set(i.province_code, (counts.get(i.province_code) ?? 0) + 1);
    const { items } = Provinces.parse(await (await s.req(`${V1}/provinces`)).json());
    expect(Object.fromEntries(items.map((p) => [p.code, p.museum_count]))).toEqual(
      Object.fromEntries(items.map((p) => [p.code, counts.get(p.code) ?? 0])),
    );
    expect(items.reduce((n, p) => n + p.museum_count, 0)).toBeLessThanOrEqual(s.cat.visibleCount);
  });

  it('the list total is the visible count, with every filter of a hidden museum', async () => {
    const total = async (qs: string) =>
      MuseumList.parse(await (await s.req(`${V1}/museums?${qs}&limit=1`)).json()).total;
    expect(await total('sort=rank')).toBe(s.cat.visibleCount);
    for (const province of new Set(hidden.map((h) => h.province).filter((p) => p !== null))) {
      expect(await total(`province=${province}`)).toBe(visible.filter((i) => i.province_code === province).length);
    }
  });

  it("filtered walks by each hidden museum's province, category and mk hold none", async () => {
    const filters: Record<string, string>[] = [{ mk: 'participating' }];
    for (const p of new Set(hidden.map((h) => h.province).filter((x): x is string => x !== null)))
      filters.push({ province: p });
    for (const c of new Set(hidden.flatMap((h) => h.categories))) filters.push({ category: c });
    for (const h of hidden) {
      const f: Record<string, string> = { mk: 'participating', sort: 'name' };
      if (h.province !== null) f.province = h.province;
      if (h.categories[0] !== undefined) f.category = h.categories[0];
      filters.push(f);
    }
    for (const f of filters) {
      const items = await walk(s, f);
      expect(
        items.filter((i) => hiddenIds.has(i.id) || hiddenSlugs.has(i.slug)),
        JSON.stringify(f),
      ).toEqual([]);
    }
  }, 120_000);

  it('no q search and no suggest finds one, by name or alias, accented or not', async () => {
    for (const h of hidden) {
      for (const q of queries(h)) {
        const items = await walk(s, { q });
        expect(
          items.filter((i) => hiddenIds.has(i.id) || hiddenSlugs.has(i.slug)),
          `list q for ${h.slug}`,
        ).toEqual([]);
        const sg = Suggest.parse(await (await s.req(`${V1}/museums/suggest?${new URLSearchParams({ q })}`)).json());
        expect(
          sg.items.filter((i) => hiddenSlugs.has(i.slug)),
          `suggest for ${h.slug}`,
        ).toEqual([]);
      }
    }
  }, 300_000);

  it('near-me at the exact coordinates holds none', async () => {
    let asked = 0;
    for (const h of hidden) {
      if (h.lat === null || h.lon === null) continue;
      for (const [lat, lon] of [
        [h.lat, h.lon],
        [Math.round(h.lat * 1000) / 1000, Math.round(h.lon * 1000) / 1000],
      ] as const) {
        const r = await s.req(`${V1}/museums/near?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&limit=50`);
        expect(r.status, h.slug).toBe(200);
        const { items } = NearList.parse(await r.json());
        expect(items.length).toBeGreaterThan(0);
        expect(
          items.filter((i) => hiddenIds.has(i.id) || hiddenSlugs.has(i.slug)),
          h.slug,
        ).toEqual([]);
        asked++;
      }
    }
    expect(asked).toBeGreaterThan(20);
  });

  it('the detail and every old slug of a hidden museum is a 404', async () => {
    const slugs = [...hiddenSlugs, s.cat.named.hiddenWithOldSlug.oldSlug];
    const owner = new pg.Client({ connectionString: s.tdb.urls.mjk_migrator });
    await owner.connect();
    try {
      const old = await owner.query<{ old_slug: string }>(
        'SELECT old_slug FROM museum_slug_redirect WHERE museum_id = ANY($1)',
        [[...hiddenIds]],
      );
      slugs.push(...old.rows.map((r) => r.old_slug));
    } finally {
      await owner.end();
    }
    for (const slug of slugs) {
      const r = await s.req(`${V1}/museums/${slug}`);
      expect(r.status, slug).toBe(404);
      expect(r.headers.get('location'), slug).toBeNull();
      expect(ErrorBody.parse(await r.json())).toEqual({ error: 'not_found' });
    }
  });
});
