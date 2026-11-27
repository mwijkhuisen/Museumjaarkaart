import type { Locale } from './routes.ts';

// Dates render the same on the server and in the browser (A§15.1 hydration rules): Intl in
// Europe/Amsterdam, long month names (Node's ICU and WebKit disagree on short Dutch ones), and
// never the clock.

const TAG: Record<Locale, string> = { nl: 'nl-NL', en: 'en-GB' };
const ZONE = 'Europe/Amsterdam';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Noon UTC on an ISO date (YYYY-MM-DD, the contracts' IsoDate) is that same date in Amsterdam. A
 * datetime is refused, not cut to its UTC day (which is not always the Amsterdam day).
 */
const noon = (iso: string) => {
  if (!DATE_ONLY.test(iso)) throw new RangeError('not_an_iso_date');
  return new Date(`${iso}T12:00:00Z`);
};

/** "1 november 2026" / "1 November 2026". */
export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], {
    timeZone: ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(noon(iso));
}

/** "november 2026" / "November 2026": the Museumkaart list date. */
export function formatMonth(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], { timeZone: ZONE, month: 'long', year: 'numeric' }).format(noon(iso));
}

/** "1 november 2026 14:05" / "1 November 2026 at 14:05": an instant (a contract IsoDateTime) in Amsterdam. */
export function formatDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], {
    timeZone: ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "1 november 2026" / "1 November 2026": the Amsterdam day of an instant (a contract IsoDateTime). */
export function formatDay(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(TAG[locale], {
    timeZone: ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}

/** "4,3" / "4.3": a mean with one decimal, in the page's language. */
export function formatMean(mean: number, locale: Locale): string {
  return new Intl.NumberFormat(TAG[locale], { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(mean);
}

/** "1.234" / "1,234". */
export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(TAG[locale]).format(n);
}

/** "€ 12,50" / "€12.50": euro cents (a net figure can be negative). */
export function formatMoney(cents: number, locale: Locale): string {
  return new Intl.NumberFormat(TAG[locale], { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/** "450 m", "12,3 km": the distance of a near-me answer (whole metres from the API). */
export function formatDistance(metres: number, locale: Locale): string {
  if (metres < 1000) return `${new Intl.NumberFormat(TAG[locale]).format(Math.round(metres))} m`;
  const km = new Intl.NumberFormat(TAG[locale], { maximumFractionDigits: 1 }).format(metres / 1000);
  return `${km} km`;
}
