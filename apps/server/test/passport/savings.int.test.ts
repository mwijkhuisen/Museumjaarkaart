import { MeProgress } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeProgress } from '../../src/api/routes/me-progress.ts';
import type { Db } from '../../src/db/kysely.ts';
import { memberSavings } from '../../src/passport/savings.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c WP4: € saved over the seeded catalogue, and GET /me/progress. The museums of a test get their curated
// columns set as the owner, so the figures are worked out by hand; each test sets every column it relies on.

let p: PassportDb;
let api: Db;
beforeAll(async () => {
  p = await openPassportDb();
  api = p.db;
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const TODAY = '2026-11-27';
const FRESH = '2026-03-01T12:00:00Z';

type Curated = Partial<{
  status: string;
  since: string | null;
  until: string | null;
  cents: number | null;
  verified: string | null;
}>;
/** Sets the Museumkaart columns of a museum as the owner; unmentioned ones become the "participating, open, no price" state. */
const curate = (id: string, c: Curated) =>
  p.owner.query(
    `UPDATE museum SET museumkaart_status = $2, mk_since = $3, mk_until = $4, admission_adult_cents = $5,
       price_verified_at = $6 WHERE id = $1`,
    [id, c.status ?? 'participating', c.since ?? null, c.until ?? null, c.cents ?? null, c.verified ?? null],
  );
const nameOf = async (id: string) =>
  (await p.owner.query<{ name: string }>('SELECT name FROM museum WHERE id = $1', [id])).rows[0]?.name as string;

describe('memberSavings: the fixture year', () => {
  it('equals the A§10 formula, and names the unpriced and the stale-priced museum', async () => {
    const u = await p.newMember();
    // Seven distinct visible museums, none of them hidden.
    const [twice, none, stale, left, noSince, unknown, undated] = await Promise.all(
      Array.from({ length: 7 }, (_, i) => p.visible(20 + i)),
    );
    const id = (m: typeof twice) => (m as { id: string }).id;
    await curate(id(twice), { cents: 1500, verified: FRESH, since: '2019-01-01' });
    await curate(id(none), { cents: null });
    await curate(id(stale), { cents: 1800, verified: '2025-05-26T12:00:00Z' }); // a day past 18 months
    await curate(id(left), { status: 'left', since: '2015-01-01', until: '2026-03-31', cents: 2000, verified: FRESH });
    await curate(id(noSince), { cents: 1000, verified: FRESH, since: null });
    await curate(id(unknown), { status: 'unknown', cents: 900, verified: FRESH });
    await curate(id(undated), { cents: 700, verified: FRESH });

    await p.addVisit(u.id, id(twice), { on: '2026-02-10' });
    await p.addVisit(u.id, id(twice), { on: '2026-09-10' });
    await p.addVisit(u.id, id(none), { on: '2026-04-01' });
    await p.addVisit(u.id, id(stale), { on: '2026-05-05' });
    await p.addVisit(u.id, id(left), { on: '2026-06-01' }); // after it left the card
    await p.addVisit(u.id, id(noSince), { on: '2026-07-07' });
    await p.addVisit(u.id, id(unknown), { on: '2026-08-08' });
    await p.addVisit(u.id, id(undated), { on: null });
    // A hidden museum is not the member's to count.
    const hid = await p.hidden();
    await curate(hid.id, { cents: 5000, verified: FRESH });
    await p.addVisit(u.id, hid.id, { on: '2026-10-10' });

    const [y, ...rest] = await memberSavings(api, u.id, 'adult', TODAY);
    expect(rest).toEqual([]);
    // 15,00 + 15,00 (twice) + 10,00 (no mk_since) = 40,00 over 3 visits; the card costs 75,00.
    expect(y).toMatchObject({ year: 2026, card_type: 'adult', saved_cents: 4000, counted: 3 });
    expect(y).toMatchObject({ card_price_cents: 7500, net_cents: -3500, reason: null });
    const named = y?.unpriced.map((x) => [x.museum.id, x.stale]).sort();
    expect(named).toEqual(
      [
        [id(none), false],
        [id(stale), true],
      ].sort(),
    );
    expect(y?.unpriced.find((x) => x.museum.id === id(none))?.museum.name).toBe(await nameOf(id(none)));
    expect(y?.unpriced.every((x) => x.museum.slug !== null)).toBe(true);

    // Left inside its dates counts: the visit before it left.
    await p.addVisit(u.id, id(left), { on: '2026-03-31' });
    const [after] = await memberSavings(api, u.id, 'under_19', TODAY);
    expect(after).toMatchObject({ saved_cents: 6000, counted: 4, card_price_cents: 3900, net_cents: 2100 });
  });

  it('a price is judged by its Amsterdam date: 00:30 on the first fresh day counts, 23:30 the day before does not', async () => {
    const u = await p.newMember();
    const [a, b] = [await p.visible(40), await p.visible(41)];
    await curate(a.id, { cents: 1000, verified: '2025-05-26T22:30:00Z' }); // 2025-05-27 00:30 in Amsterdam
    await curate(b.id, { cents: 1000, verified: '2025-05-26T21:30:00Z' }); // 2025-05-26 23:30
    await p.addVisit(u.id, a.id, { on: '2026-06-01' });
    await p.addVisit(u.id, b.id, { on: '2026-06-01' });
    const [y] = await memberSavings(api, u.id, 'adult', TODAY);
    expect(y).toMatchObject({ saved_cents: 1000, counted: 1 });
    expect(y?.unpriced.map((x) => x.museum.id)).toEqual([b.id]);
  });

  it('a price that was never verified is stale; a year without a card price has no net figure', async () => {
    const u = await p.newMember();
    const m = await p.visible(42);
    await curate(m.id, { cents: 1000, verified: null });
    await p.addVisit(u.id, m.id, { on: '2027-01-05' });
    await p.addVisit(u.id, m.id, { on: '2026-01-05' });
    const ys = await memberSavings(api, u.id, 'adult', TODAY);
    expect(ys.map((y) => y.year)).toEqual([2027, 2026]);
    expect(ys[0]).toMatchObject({ card_price_cents: null, net_cents: null, reason: 'no_card_price', saved_cents: 0 });
    expect(ys[0]?.unpriced).toEqual([expect.objectContaining({ stale: true })]);
  });

  it('only the member own visits count', async () => {
    const [u, other] = [await p.newMember(), await p.newMember()];
    const m = await p.visible(43);
    await curate(m.id, { cents: 1000, verified: FRESH });
    await p.addVisit(other.id, m.id, { on: '2026-06-01' });
    expect(await memberSavings(api, u.id, 'adult', TODAY)).toEqual([]);
  });
});

describe('GET /me/progress', () => {
  it('is 401 signed out', async () => {
    const { call } = meApp(p, mountMeProgress);
    expect((await call('/me/progress')).status).toBe(401);
  });

  it('answers progress and € saved as MeProgress, private and uncacheable', async () => {
    const { call, signIn } = meApp(p, mountMeProgress);
    const u = await p.newMember();
    const m = await p.listed(10);
    await curate(m.id, { cents: 1000, verified: new Date().toISOString() });
    await p.addVisit(u.id, m.id, { on: '2026-06-01' });
    const r = await call('/me/progress', { token: await signIn(u.id) });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = MeProgress.parse(await r.json());
    expect(body.progress).toMatchObject({ all_time: 1, years: [{ year: 2026, museums: 1 }] });
    expect(body.progress.list).toMatchObject({ visited: 1, n: p.catalogue.list.n });
    expect(body.savings).toEqual([
      expect.objectContaining({ year: 2026, card_type: 'adult', card_price_cents: 7500, saved_cents: 1000 }),
    ]);
  });

  it('prices the year at the member card type, and takes no query', async () => {
    const { call, signIn } = meApp(p, mountMeProgress);
    const u = await p.newMember({ settings: { card_type: 'under_19' } });
    await p.addVisit(u.id, (await p.visible(44)).id, { on: '2026-06-01' });
    const token = await signIn(u.id);
    const body = MeProgress.parse(await (await call('/me/progress', { token })).json());
    expect(body.savings[0]).toMatchObject({ card_type: 'under_19', card_price_cents: 3900 });
    expect((await call('/me/progress?x=1', { token })).status).toBe(400);
  });

  it('never shows another member their visits', async () => {
    const { call, signIn } = meApp(p, mountMeProgress);
    const [u, other] = [await p.newMember(), await p.newMember()];
    await p.addVisit(other.id, (await p.listed(11)).id);
    const body = MeProgress.parse(await (await call('/me/progress', { token: await signIn(u.id) })).json());
    expect(body.progress.all_time).toBe(0);
    expect(body.savings).toEqual([]);
  });
});
