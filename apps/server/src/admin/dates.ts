// Dates for the admin CLI. Node 26 has `Temporal`, but the TypeScript lib in use (es2024) does not
// type it, so this file declares the few members it needs and is the only place that touches it.

type Instant = { readonly epochMilliseconds: number; toString(opts?: { timeZone: string }): string };
type PlainDate = { toString(): string; toZonedDateTime(tz: string): { toInstant(): Instant } };
type TemporalApi = {
  PlainDate: { from(text: string, opts: { overflow: 'reject' }): PlainDate };
  Instant: { from(text: string): Instant; fromEpochMilliseconds(ms: number): Instant };
  Now: { plainDateISO(tz: string): PlainDate };
};

const T = (globalThis as unknown as { Temporal: TemporalApi }).Temporal;
const ZONE = 'Europe/Amsterdam';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `YYYY-MM-DD` of a real calendar day (no 2026-02-30), else undefined. */
export function parseDate(text: string): string | undefined {
  if (!DATE.test(text)) return undefined;
  try {
    return T.PlainDate.from(text, { overflow: 'reject' }).toString();
  } catch {
    return undefined;
  }
}

/** Today in Europe/Amsterdam as `YYYY-MM-DD`. */
export const todayAmsterdam = (): string => T.Now.plainDateISO(ZONE).toString();

/** The start of a day in Europe/Amsterdam, in milliseconds since the epoch. */
export function startOfDayMs(date: string): number {
  return T.PlainDate.from(date, { overflow: 'reject' }).toZonedDateTime(ZONE).toInstant().epochMilliseconds;
}

/** An ISO timestamp with an offset (the CSV form) as milliseconds, else undefined. */
export function parseInstantMs(text: string): number | undefined {
  if (!INSTANT.test(text)) return undefined;
  try {
    return T.Instant.from(text).epochMilliseconds;
  } catch {
    return undefined;
  }
}

/** Milliseconds as ISO with the Amsterdam offset, e.g. `2026-11-02T00:00:00+01:00`. */
export const formatInstant = (ms: number): string => T.Instant.fromEpochMilliseconds(ms).toString({ timeZone: ZONE });
