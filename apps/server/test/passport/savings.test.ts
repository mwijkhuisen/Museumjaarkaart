import { expect, it } from 'vitest';
import { cardPriceCents } from '../../src/passport/card-price.ts';
import { isPriceFresh, type SavingsVisit, savingsOf } from '../../src/passport/savings.ts';

// The fixture year of PHASES §3 P2c, worked out by hand. Today is 2026-11-27, so a price is fresh when it was
// verified on or after 2025-05-27 (18 months back).
const TODAY = '2026-11-27';
const museum = (id: string, name: string) => ({ id, slug: id, name, name_en: null, place: null });
const FRESH = '2026-03-01';
const OLD = '2025-05-26'; // one day past the 18 months

const v = (id: string, over: Partial<SavingsVisit> & { visited_on: string }): SavingsVisit => ({
  museum: museum(id, id.toUpperCase()),
  museumkaart_status: 'participating',
  mk_since: null,
  mk_until: null,
  price_cents: 1500,
  price_verified_on: FRESH,
  ...over,
});

// 2026: A twice at 15,00 (30,00) · B has no price · C's price was verified 2025-05-26 (stale) · D left the card on
// 2026-03-31 and was visited 2026-06-01 · E participates with no mk_since, 10,00 · F (unknown status) · an undated
// visit never reaches the function (the loader drops it).
const fixtureYear: SavingsVisit[] = [
  v('a', { visited_on: '2026-02-10' }),
  v('a', { visited_on: '2026-09-10' }),
  v('b', { visited_on: '2026-04-01', price_cents: null, price_verified_on: null }),
  v('c', { visited_on: '2026-05-05', price_verified_on: OLD }),
  v('d', { visited_on: '2026-06-01', museumkaart_status: 'left', mk_since: '2020-01-01', mk_until: '2026-03-31' }),
  v('e', { visited_on: '2026-07-07', price_cents: 1000, mk_since: null }),
  v('f', { visited_on: '2026-08-08', museumkaart_status: 'unknown' }),
];

it('the fixture year: 30,00 + 10,00 saved over three visits, minus the 75,00 adult card', () => {
  const [y, ...rest] = savingsOf(fixtureYear, 'adult', TODAY);
  expect(rest).toEqual([]);
  expect(y).toEqual({
    year: 2026,
    card_type: 'adult',
    saved_cents: 1500 + 1500 + 1000,
    counted: 3,
    card_price_cents: 7500,
    net_cents: 4000 - 7500,
    reason: null,
    unpriced: [
      { museum: museum('b', 'B'), stale: false },
      { museum: museum('c', 'C'), stale: true },
    ],
  });
});

it('an under-19 card changes only the card price, not the admission used', () => {
  const [y] = savingsOf(fixtureYear, 'under_19', TODAY);
  expect(y).toMatchObject({ card_type: 'under_19', saved_cents: 4000, card_price_cents: 3900, net_cents: 100 });
});

it('a museum is named once per year however often it was visited, and a priced visit of it still counts', () => {
  const rows = [
    v('b', { visited_on: '2026-01-01', price_cents: null, price_verified_on: null }),
    v('b', { visited_on: '2026-02-02', price_cents: null, price_verified_on: null }),
  ];
  expect(savingsOf(rows, 'adult', TODAY)[0]?.unpriced).toHaveLength(1);
});

it('the status and the dates: left counts only inside them, unknown never, an open end is open', () => {
  const day = (over: Partial<SavingsVisit>) =>
    savingsOf([v('x', { visited_on: '2026-06-15', ...over })], 'adult', TODAY)[0];
  expect(day({ museumkaart_status: 'left', mk_since: '2026-06-15', mk_until: '2026-06-15' })?.counted).toBe(1);
  expect(day({ museumkaart_status: 'left', mk_since: '2020-01-01', mk_until: '2026-06-14' })?.counted).toBe(0);
  expect(day({ mk_since: '2026-06-16' })?.counted).toBe(0);
  expect(day({ mk_since: '2026-06-15', mk_until: null })?.counted).toBe(1);
  expect(day({ museumkaart_status: 'unknown' })?.counted).toBe(0);
  // A visit outside the card's dates is not an unpriced museum either: it is simply not counted.
  expect(day({ museumkaart_status: 'unknown', price_cents: null })?.unpriced).toEqual([]);
});

it('a price verified exactly 18 months ago still counts, one day later it does not', () => {
  expect(isPriceFresh('2025-05-27', TODAY)).toBe(true);
  expect(isPriceFresh('2025-05-26', TODAY)).toBe(false);
  expect(isPriceFresh(null, TODAY)).toBe(false);
});

it('years come newest first, and a year without a card price shows no net figure and says why', () => {
  const rows = [
    v('a', { visited_on: '2025-05-05' }),
    v('a', { visited_on: '2026-05-05' }),
    v('a', { visited_on: '2027-01-02' }),
  ];
  const ys = savingsOf(rows, 'adult', '2027-02-01');
  expect(ys.map((y) => y.year)).toEqual([2027, 2026, 2025]);
  expect(ys[0]).toMatchObject({ card_price_cents: null, net_cents: null, reason: 'no_card_price', saved_cents: 1500 });
  expect(ys[1]).toMatchObject({ card_price_cents: 7500, net_cents: 1500 - 7500, reason: null });
  expect(ys[2]).toMatchObject({ card_price_cents: null, net_cents: null, reason: 'no_card_price' });
});

it('a year with only uncounted visits is still listed, at zero', () => {
  expect(savingsOf([v('f', { visited_on: '2026-08-08', museumkaart_status: 'unknown' })], 'adult', TODAY)).toEqual([
    expect.objectContaining({ year: 2026, saved_cents: 0, counted: 0, net_cents: -7500, unpriced: [] }),
  ]);
});

it('no visits, no years', () => {
  expect(savingsOf([], 'adult', TODAY)).toEqual([]);
});

it('the card prices: 2026 is €75 and €39, any other year has none', () => {
  expect(cardPriceCents(2026, 'adult')).toBe(7500);
  expect(cardPriceCents(2026, 'under_19')).toBe(3900);
  expect(cardPriceCents(2025, 'adult')).toBeNull();
});
