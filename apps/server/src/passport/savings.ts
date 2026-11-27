import type { SavingsYear, VisitMuseum } from '@mjk/contracts';
import { sql } from 'kysely';
import { formatInstant, monthsBefore } from '../admin/dates.ts';
import type { Db } from '../db/kysely.ts';
import { type CardType, cardPriceCents } from './card-price.ts';

// € saved per calendar year (A§10, P2c). Binding rules:
//  - only dated visits count; a visit counts when its museum's status is `participating` or `left` and the
//    visit date lies in [mk_since, mk_until] (a null end is open): `unknown` never counts, `left` only inside
//    its dates;
//  - a counted visit adds the adult admission each time, but only when a price exists and was verified within
//    18 months of today (Q8: judged against today, by the date in Europe/Amsterdam); otherwise the visit is left
//    out and its museum is named once for that year in `unpriced` (`stale` when a price exists but is old);
//  - net = saved - the year's card price for the member's card type; no price for the year, no net figure.
// The adult price is used for every card type (the page says so).

/** A dated visit with the facts of its museum. `price_verified_on` is the Amsterdam date of `price_verified_at`. */
export type SavingsVisit = {
  museum: VisitMuseum;
  visited_on: string;
  museumkaart_status: string;
  mk_since: string | null;
  mk_until: string | null;
  price_cents: number | null;
  price_verified_on: string | null;
};

export const STALE_MONTHS = 18;

/** A price verified on `verifiedOn` (an Amsterdam date) still counts on `today`: within 18 months (Q8). */
export const isPriceFresh = (verifiedOn: string | null, today: string): boolean =>
  verifiedOn !== null && verifiedOn >= monthsBefore(today, STALE_MONTHS);

export function savingsOf(visits: readonly SavingsVisit[], cardType: CardType, today: string): SavingsYear[] {
  const perYear = new Map<number, SavingsVisit[]>();
  for (const v of visits) {
    const year = Number(v.visited_on.slice(0, 4));
    const list = perYear.get(year);
    if (list === undefined) perYear.set(year, [v]);
    else list.push(v);
  }
  return [...perYear]
    .sort(([a], [b]) => b - a)
    .map(([year, list]) => {
      let saved = 0;
      let counted = 0;
      const unpriced = new Map<string, { museum: VisitMuseum; stale: boolean }>();
      for (const v of list) {
        const inCard =
          (v.museumkaart_status === 'participating' || v.museumkaart_status === 'left') &&
          (v.mk_since === null || v.mk_since <= v.visited_on) &&
          (v.mk_until === null || v.visited_on <= v.mk_until);
        if (!inCard) continue;
        if (v.price_cents !== null && isPriceFresh(v.price_verified_on, today)) {
          saved += v.price_cents;
          counted += 1;
        } else if (!unpriced.has(v.museum.id)) {
          unpriced.set(v.museum.id, { museum: v.museum, stale: v.price_cents !== null });
        }
      }
      const card = cardPriceCents(year, cardType);
      return {
        year,
        card_type: cardType,
        saved_cents: saved,
        counted,
        card_price_cents: card,
        net_cents: card === null ? null : saved - card,
        reason: card === null ? ('no_card_price' as const) : null,
        unpriced: [...unpriced.values()].sort(
          (a, b) => a.museum.name.localeCompare(b.museum.name) || a.museum.id.localeCompare(b.museum.id),
        ),
      };
    });
}

/** The member's dated visits to visible museums, as `mjk_api`. `today` is `todayAmsterdam()`. */
export async function memberSavings(db: Db, userId: string, cardType: CardType, today: string): Promise<SavingsYear[]> {
  const rows = await db
    .selectFrom('visit as v')
    .innerJoin('pub_museum as m', 'm.id', 'v.museum_id')
    .select([
      'm.id',
      'm.slug',
      'm.name',
      'm.name_en',
      'm.place',
      sql<string>`v.visited_on::text`.as('visited_on'),
      'm.museumkaart_status',
      sql<string | null>`m.mk_since::text`.as('mk_since'),
      sql<string | null>`m.mk_until::text`.as('mk_until'),
      'm.admission_adult_cents',
      'm.price_verified_at',
    ])
    .where('v.user_id', '=', userId)
    .where('v.visited_on', 'is not', null)
    .execute();
  return savingsOf(
    rows.map((r) => ({
      museum: { id: r.id as string, slug: r.slug, name: r.name as string, name_en: r.name_en, place: r.place },
      visited_on: r.visited_on as string,
      museumkaart_status: r.museumkaart_status as string,
      mk_since: r.mk_since,
      mk_until: r.mk_until,
      price_cents: r.admission_adult_cents,
      // The Amsterdam date: formatInstant writes the Amsterdam offset, so its first ten characters are it.
      price_verified_on:
        r.price_verified_at === null ? null : formatInstant(r.price_verified_at.getTime()).slice(0, 10),
    })),
    cardType,
    today,
  );
}
