import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';
import { CATALOGUE_TOTAL, type SeededCatalogue, seedCatalogue } from './seed-catalogue.ts';

// P1b WP4: the catalogue helper that the search, filter, near-me, hidden-sweep and EXPLAIN tests seed.

let db: TestDb;
let db2: TestDb | undefined;
let cat: SeededCatalogue;
let seedMs = 0;
let api: pg.Client;
let ssr: pg.Client;
const clients: pg.Client[] = [];

async function login(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
}

const num = async (c: pg.Client, text: string, values: unknown[] = []): Promise<number> =>
  Number(((await c.query(text, values)).rows[0] as { n: string }).n);

beforeAll(async () => {
  db = await createMigratedDb();
  const t0 = performance.now();
  cat = await seedCatalogue(db);
  seedMs = performance.now() - t0;
  api = await login(db.urls.mjk_api);
  ssr = await login(db.urls.mjk_ssr);
  console.info(`seedCatalogue: ${Math.round(seedMs)} ms`);
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await db?.drop();
  await db2?.drop();
});

describe('seedCatalogue', () => {
  it('holds exactly 1,400 museums and hides the hidden ones from pub_museum', async () => {
    expect(cat.total).toBe(CATALOGUE_TOTAL);
    expect(await num(api, 'SELECT count(*) AS n FROM museum')).toBe(1400);
    expect(await num(api, 'SELECT count(*) AS n FROM museum WHERE hidden')).toBe(cat.hiddenIds.length);
    expect(cat.hiddenIds.length).toBeGreaterThanOrEqual(25);
    expect(cat.visibleCount).toBe(1400 - cat.hiddenIds.length);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum')).toBe(cat.visibleCount);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE id = ANY($1::uuid[])', [cat.hiddenIds])).toBe(0);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE slug = ANY($1::text[])', [cat.hiddenSlugs])).toBe(
      0,
    );
    expect(
      await num(api, 'SELECT count(*) AS n FROM museum WHERE slug = ANY($1::text[]) AND hidden', [cat.hiddenSlugs]),
    ).toBe(cat.hiddenIds.length);
  });

  it('computes a non-empty search for every museum', async () => {
    const empty = await api.query("SELECT name FROM museum WHERE search = ''::tsvector");
    expect(empty.rows).toEqual([]);
  });

  it('seeds Kroller-Muller with accented aliases only, and the Rijksmuseum', async () => {
    const k = await ssr.query(
      'SELECT m.lat, m.lon, m.name_folded, (SELECT array_agg(a.alias) FROM pub_museum_alias a WHERE a.museum_id = m.id) AS aliases FROM pub_museum m WHERE m.id = $1',
      [cat.named.kroller.id],
    );
    const row = k.rows[0] as { lat: number; lon: number; name_folded: string; aliases: string[] };
    expect(row.lat).toBeCloseTo(52.0958, 3);
    expect(row.name_folded).toBe('Kroller Muller Museum');
    expect(row.aliases.length).toBeGreaterThan(3);
    for (const a of row.aliases) expect(a).toMatch(/[^\p{ASCII}]/u);

    const r = await ssr.query(
      'SELECT name, name_en, place, municipality_code, province_code, street, house_number, postcode, lat, lon, categories, registered, museumkaart_status, mk_since::text AS mk_since FROM pub_museum WHERE id = $1',
      [cat.named.rijksmuseum.id],
    );
    expect(r.rows[0]).toMatchObject({
      name: 'Rijksmuseum',
      name_en: 'Rijksmuseum',
      municipality_code: 'GM0363',
      province_code: 'NL-NH',
      street: 'Museumstraat',
      house_number: '1',
      postcode: '1071 XX',
      lat: 52.36,
      lon: 4.8852,
      categories: ['art', 'history'],
      registered: true,
      museumkaart_status: 'participating',
    });
    expect((r.rows[0] as { mk_since: string }).mk_since).not.toBeNull();
    // P1a's other Rijksmuseum rows stay visible.
    for (const n of [
      'Rijksmuseum Boerhaave',
      'Rijksmuseum Twenthe',
      'Rijksmuseum Muiderslot',
      'Rijksmuseum De Gevangenpoort',
    ]) {
      expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE name = $1', [n])).toBe(1);
    }
    const hr = await api.query('SELECT name, hidden, rce_id FROM museum WHERE id = $1', [
      cat.named.hiddenRijksmuseum.id,
    ]);
    expect(hr.rows[0]).toMatchObject({ name: 'Rijksmuseum Amsterdam', hidden: true });
    expect((hr.rows[0] as { rce_id: string | null }).rce_id).not.toBeNull();
  });

  it('seeds hidden museums with lookalikes, coordinates, aliases, provinces and Museumkaart', async () => {
    const h = await api.query(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE m.lat IS NOT NULL) AS coords,
              count(*) FILTER (WHERE m.museumkaart_status = 'participating') AS mk,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM museum_alias a WHERE a.museum_id = m.id)) AS aliases,
              count(DISTINCT mu.province_code) AS provinces
       FROM museum m LEFT JOIN municipality mu ON mu.cbs_code = m.municipality_code WHERE m.hidden`,
    );
    const row = h.rows[0] as Record<string, string>;
    const n = Number(row.n);
    expect(n).toBeGreaterThanOrEqual(25);
    expect(Number(row.coords)).toBe(n);
    expect(Number(row.mk)).toBe(n);
    expect(Number(row.aliases)).toBe(n);
    expect(Number(row.provinces)).toBeGreaterThanOrEqual(5);
    expect(await num(api, "SELECT count(*) AS n FROM museum WHERE hidden AND name LIKE 'Kröller%Beeldentuin'")).toBe(1);
    expect(
      await num(api, "SELECT count(*) AS n FROM museum WHERE hidden AND name = 'Rijksmuseum Amsterdam Depot'"),
    ).toBe(1);

    const { id, oldSlug } = cat.named.hiddenWithOldSlug;
    expect(
      await num(api, 'SELECT count(*) AS n FROM museum_slug_redirect WHERE old_slug = $1 AND museum_id = $2', [
        oldSlug,
        id,
      ]),
    ).toBe(1);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_slug_redirect WHERE old_slug = $1', [oldSlug])).toBe(0);
  });

  it('seeds closed and temporarily closed museums', async () => {
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE closed_on < '2026-11-02'"),
    ).toBeGreaterThanOrEqual(10);
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE closed_on < '2026-11-02' AND lat IS NOT NULL"),
    ).toBeGreaterThanOrEqual(5);
    expect(await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE closed_on > '2026-11-02'")).toBe(1);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE temp_closed')).toBeGreaterThanOrEqual(5);
    expect(
      await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE temp_closed AND temp_closed_until IS NOT NULL'),
    ).toBeGreaterThanOrEqual(3);
  });

  it('seeds equal names, accent variants, equal coordinates and near ties', async () => {
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE name = 'Stedelijk Museum'"),
    ).toBeGreaterThanOrEqual(6);
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE sort_name = 'oland museum'"),
    ).toBeGreaterThanOrEqual(4);
    expect(
      await num(ssr, "SELECT count(DISTINCT name) AS n FROM pub_museum WHERE sort_name = 'oland museum'"),
    ).toBeGreaterThanOrEqual(3);

    const { lat, lon, ids } = cat.equalCoordinates;
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(
      await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE lat = $1 AND lon = $2 AND id = ANY($3::uuid[])', [
        lat,
        lon,
        ids,
      ]),
    ).toBe(ids.length);
    const near = (a: [number, number], b: [number, number]) =>
      num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE (lat = $1 AND lon = $2) OR (lat = $3 AND lon = $4)', [
        ...a,
        ...b,
      ]);
    expect(await near([52.01, 5.02], [51.99, 4.98])).toBe(2);
    expect(await near([52.515, 6.005], [52.485, 5.995])).toBe(2);
  });

  it('seeds at least 40 visible museums without coordinates', async () => {
    expect(
      await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE lat IS NULL AND lon IS NULL'),
    ).toBeGreaterThanOrEqual(40);
    expect(await num(api, 'SELECT count(*) AS n FROM museum WHERE (lat IS NULL) <> (lon IS NULL)')).toBe(0);
  });

  it('seeds a renamed museum with two redirects', async () => {
    const { id, slug, oldSlugs } = cat.named.renamed;
    const r = await ssr.query('SELECT old_slug FROM pub_slug_redirect WHERE slug = $1 ORDER BY old_slug', [slug]);
    expect(r.rows.map((x: { old_slug: string }) => x.old_slug)).toEqual([...oldSlugs].sort());
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE id = $1 AND slug = $2', [id, slug])).toBe(1);
  });

  it('seeds the Museumkaart statuses and the published list', async () => {
    const visible = cat.visibleCount;
    const participating = await num(
      ssr,
      "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'participating'",
    );
    expect(participating / visible).toBeGreaterThan(0.25);
    expect(participating / visible).toBeLessThan(0.4);
    expect(
      await num(
        ssr,
        "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'participating' AND mk_since IS NULL",
      ),
    ).toBe(0);
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'left'"),
    ).toBeGreaterThanOrEqual(10);
    expect(
      await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'left' AND mk_since <= mk_until"),
    ).toBe(await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'left'"));
    expect(await num(ssr, "SELECT count(*) AS n FROM pub_museum WHERE museumkaart_status = 'unknown'")).toBeGreaterThan(
      0,
    );

    const list = await ssr.query('SELECT published_on::text AS published_on, n FROM pub_mk_list');
    expect(list.rows).toEqual([{ published_on: '2026-11-01', n: cat.list.n }]);
    expect(cat.list.publishedOn).toBe('2026-11-01');
    expect(await num(api, 'SELECT count(*) AS n FROM mk_list_member')).toBe(cat.list.n);
    // One member was hidden after publication: N stays, the visible members are one fewer.
    expect(
      await num(api, 'SELECT count(*) AS n FROM mk_list_member l JOIN museum m ON m.id = l.museum_id WHERE m.hidden'),
    ).toBe(1);
    expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE mk_list_member')).toBe(cat.list.n - 1);
  });

  it('seeds hostile names', async () => {
    for (const name of [
      '<script>alert(1)</script> Museum',
      'Museum ‮evil‬',
      "Robert'); DROP TABLE museum;--",
      '"Quotes" & <Ampersands>',
    ]) {
      expect(await num(ssr, 'SELECT count(*) AS n FROM pub_museum WHERE name = $1', [name])).toBe(1);
    }
  });

  it('covers every province, category, status and combined filter', async () => {
    const p = await ssr.query('SELECT code, museum_count FROM pub_province');
    expect(p.rows).toHaveLength(12);
    for (const row of p.rows as Array<{ code: string; museum_count: number }>)
      expect(row.museum_count).toBeGreaterThanOrEqual(20);

    const cats = await ssr.query('SELECT DISTINCT unnest(categories) AS c FROM pub_museum');
    expect(cats.rows.map((r: { c: string }) => r.c).sort()).toEqual([
      'art',
      'ethnology',
      'history',
      'natural_history',
      'other',
      'science_technology',
    ]);
    const reg = await ssr.query('SELECT DISTINCT registered FROM pub_museum');
    expect(reg.rows).toHaveLength(2);

    const combos = await ssr.query(
      "SELECT province_code, c, count(*) AS n FROM pub_museum, unnest(categories) AS c WHERE museumkaart_status = 'participating' AND province_code IS NOT NULL GROUP BY 1, 2",
    );
    expect(combos.rows.length).toBeGreaterThanOrEqual(40);
    const provsWithMk = await ssr.query(
      "SELECT DISTINCT province_code FROM pub_museum WHERE museumkaart_status = 'participating' AND province_code IS NOT NULL",
    );
    expect(provsWithMk.rows).toHaveLength(12);
  });

  it('is deterministic: a second database gets the same catalogue', async () => {
    const list = async (c: pg.Client) =>
      (await c.query('SELECT slug, name, lat, lon, hidden FROM museum ORDER BY slug')).rows;
    const a = await list(api);
    // roles.sql resets the cluster-wide passwords: the first database's logins are dead once a second one exists.
    db2 = await createMigratedDb();
    const cat2 = await seedCatalogue(db2);
    const b = await list(await login(db2.urls.mjk_api));
    expect(a).toHaveLength(1400);
    expect(b).toEqual(a);
    expect({ ...cat2.named.renamed, id: '' }).toEqual({ ...cat.named.renamed, id: '' });
    expect(cat2.visibleCount).toBe(cat.visibleCount);
    expect(cat2.list).toEqual(cat.list);
  }, 120_000);

  it('seeds in a few seconds', () => {
    expect(seedMs).toBeLessThan(30_000);
  });
});
