import { Progress } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { memberProgress, publicProgress } from '../../src/passport/progress.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c WP4: progress over the seeded catalogue. The api reads the member's own visits; `publicProgress` reads
// the public log as mjk_ssr (Q1's 24 h delay, visibility). Each test makes its own member, so they do not mix.

let p: PassportDb;
let api: Db;
let ssr: Db;
beforeAll(async () => {
  p = await openPassportDb();
  api = p.db;
  ssr = createDb(p.pools.ssr);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const PUBLIC = { visits_visibility: 'public' };
const DAY = 48; // hours: past Q1's delay

/** The first `n` visible museums of the newest list in id order. */
const listedMany = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => p.listed(i)));
const closed = async () =>
  (
    await p.owner.query<{ id: string }>(
      `SELECT id FROM museum WHERE NOT hidden AND closed_on IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM mk_list_member mm WHERE mm.museum_id = museum.id) ORDER BY id LIMIT 1`,
    )
  ).rows[0] as { id: string };

describe('memberProgress', () => {
  it('no visits: zeros against the published list, every province listed', async () => {
    const u = await p.newMember();
    const r = await memberProgress(api, u.id);
    expect(Progress.parse(r)).toEqual(r);
    expect(r.all_time).toBe(0);
    expect(r.years).toEqual([]);
    expect(r.list).toMatchObject({ published_on: '2026-11-01', n: p.catalogue.list.n, visited: 0 });
    expect(r.list?.provinces.reduce((s, x) => s + x.n, 0)).toBe(p.catalogue.list.n);
  });

  it('counts distinct members of the list; all time adds the others and closed museums, never hidden ones', async () => {
    const u = await p.newMember();
    const [a, b] = await listedMany(2);
    const off = await p.visible();
    const shut = await closed();
    const hid = await p.hidden();
    await p.addVisit(u.id, (a as { id: string }).id, { on: '2026-03-01' });
    await p.addVisit(u.id, (a as { id: string }).id, { on: '2026-04-01' }); // the same museum again
    await p.addVisit(u.id, (a as { id: string }).id, { on: '2025-04-01' });
    await p.addVisit(u.id, (b as { id: string }).id, { on: null });
    await p.addVisit(u.id, off.id, { on: '2026-05-01' });
    await p.addVisit(u.id, shut.id, { on: '2025-06-01' });
    await p.addVisit(u.id, hid.id, { on: '2026-06-01' });
    const r = await memberProgress(api, u.id);
    expect(r.list?.visited).toBe(2);
    expect(r.list?.n).toBe(p.catalogue.list.n);
    expect(r.all_time).toBe(4); // a, b, off, shut
    expect(r.years).toEqual([
      { year: 2026, museums: 2 }, // a, off
      { year: 2025, museums: 2 }, // a, shut
    ]);
  });

  it('a status change after publication changes neither the count nor N', async () => {
    const u = await p.newMember();
    const m = await p.listed(3);
    const off = await p.visible(3);
    await p.addVisit(u.id, m.id);
    await p.addVisit(u.id, off.id);
    const before = await memberProgress(api, u.id);
    const was = (await p.owner.query('SELECT museumkaart_status FROM museum WHERE id = $1', [m.id])).rows[0]
      .museumkaart_status as string;
    expect(was).toBe('participating');
    try {
      await p.owner.query(`UPDATE museum SET museumkaart_status = 'unknown' WHERE id = $1`, [m.id]);
      await p.owner.query(`UPDATE museum SET museumkaart_status = 'participating' WHERE id = $1`, [off.id]);
      expect(await memberProgress(api, u.id)).toEqual(before);
    } finally {
      await p.owner.query(`UPDATE museum SET museumkaart_status = 'participating' WHERE id = $1`, [m.id]);
      await p.owner.query(`UPDATE museum SET museumkaart_status = 'unknown' WHERE id = $1`, [off.id]);
    }
    expect(before.list).toMatchObject({ visited: 1, n: p.catalogue.list.n });
  });

  it('the provinces add up to the totals', async () => {
    const u = await p.newMember();
    for (const m of await listedMany(60)) await p.addVisit(u.id, m.id);
    const r = await memberProgress(api, u.id);
    const list = r.list as NonNullable<Progress['list']>;
    expect(list.visited).toBe(60);
    expect(list.provinces.reduce((s, x) => s + x.visited, 0)).toBe(list.visited);
    expect(list.provinces.reduce((s, x) => s + x.n, 0)).toBe(list.n);
    expect(list.provinces.every((x) => x.visited <= x.n)).toBe(true);
    expect(list.provinces.length).toBeGreaterThan(1);
  });
});

describe('publicProgress, as mjk_ssr', () => {
  it('reads the public log: the delay holds, the year comes from the month, private members have none', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    const [a, b, c] = await listedMany(3);
    const off = await p.visible(5);
    await p.addVisit(u.id, (a as { id: string }).id, { on: '2026-03-14', ageHours: DAY });
    await p.addVisit(u.id, (b as { id: string }).id, { on: '2025-11-02', ageHours: DAY });
    await p.addVisit(u.id, (c as { id: string }).id, { on: '2026-11-27', ageHours: 0 }); // logged just now
    await p.addVisit(u.id, off.id, { on: null, ageHours: DAY });
    const r = await publicProgress(ssr, u.handle);
    expect(Progress.parse(r)).toEqual(r);
    expect(r.list).toMatchObject({ visited: 2, n: p.catalogue.list.n });
    expect(r.all_time).toBe(3); // a, b, off: c is not public yet
    expect(r.years).toEqual([
      { year: 2026, museums: 1 },
      { year: 2025, museums: 1 },
    ]);
    // The same member's own view has the fresh visit too.
    expect((await memberProgress(api, u.id)).all_time).toBe(4);
  });

  it('a private log, an unknown handle and a banned member all read as no visits', async () => {
    const hidden = await p.newMember();
    const banned = await p.newMember({ settings: PUBLIC, status: 'banned' });
    const m = await p.listed(0);
    await p.addVisit(hidden.id, m.id, { ageHours: DAY });
    await p.addVisit(banned.id, m.id, { ageHours: DAY });
    for (const handle of [hidden.handle, banned.handle, 'nobody_here']) {
      const r = await publicProgress(ssr, handle);
      expect(r.all_time).toBe(0);
      expect(r.list?.visited).toBe(0);
      expect(r.years).toEqual([]);
    }
  });

  it('leaves out a hidden museum', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    await p.addVisit(u.id, (await p.hidden()).id, { ageHours: DAY });
    expect((await publicProgress(ssr, u.handle)).all_time).toBe(0);
  });
});
