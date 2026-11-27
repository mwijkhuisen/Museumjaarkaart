// The Museumkaart's price per calendar year, in cents, by the member's card type (A§7.5, checked 2026-11-22):
// €75 from 19 years, €39 up to and including 18, both the new-card price (a renewal costs €69). Changed by PR
// when the card's price changes; a year missing here has no card price, and € saved then shows no net figure.
export const CARD_PRICE_CENTS: Readonly<Record<number, { adult: number; under_19: number }>> = {
  2026: { adult: 7500, under_19: 3900 },
};

export type CardType = 'adult' | 'under_19';

export const cardPriceCents = (year: number, type: CardType): number | null => CARD_PRICE_CENTS[year]?.[type] ?? null;
