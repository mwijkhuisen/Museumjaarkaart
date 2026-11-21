import type { Locale } from './routes.ts';

// Dates render the same on the server and in the browser (A§15.1 hydration rules): Intl in
// Europe/Amsterdam, long month names (Node's ICU and WebKit disagree on short Dutch ones), and
// never the clock.

const TAG: Record<Locale, string> = { nl: 'nl-NL', en: 'en-GB' };
const ZONE = 'Europe/Amsterdam';

/** Noon UTC on an ISO date (YYYY-MM-DD) is that same date in Amsterdam. */
const noon = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

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
