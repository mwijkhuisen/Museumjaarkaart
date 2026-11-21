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

/** "1.234" / "1,234". */
export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(TAG[locale]).format(n);
}
