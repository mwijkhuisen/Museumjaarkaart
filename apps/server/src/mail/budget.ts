import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';

// The mail budget (A§17.7, ADR-0012): Lettermint's free plan is a hard cap per month, so every sent mail
// counts in one `rate_limit` window (bucket `mail_sent`, key `site`) that runs from the start of the
// calendar month in Europe/Amsterdam to the start of the next. At 80 % of MJK_MAIL_CAP the worker logs
// `mail_cap_near` and its health ping fails.

type Env = Readonly<Record<string, string | undefined>>;

const START = sql`date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam'`;
const END = sql`(date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') + interval '1 month') AT TIME ZONE 'Europe/Amsterdam'`;

/** The monthly cap, or undefined when MJK_MAIL_CAP is unset or not a positive integer (the check is then off). */
export function mailCap(env: Env): number | undefined {
  const v = env.MJK_MAIL_CAP;
  return v !== undefined && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : undefined;
}

/** At or above 80 % of the cap. */
export const nearCap = (count: number, cap: number): boolean => count * 5 >= cap * 4;

/** One atomic upsert: this month's count after counting one more mail. */
export async function countMailSent(db: Db): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    INSERT INTO rate_limit (bucket, key, window_start, window_end, count)
    VALUES ('mail_sent', 'site', ${START}, ${END}, 1)
    ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = rate_limit.count + 1
    RETURNING count`.execute(db);
  return rows[0]?.count ?? 0;
}

/** This month's count so far. */
export async function mailSentThisMonth(db: Db): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT count FROM rate_limit
    WHERE bucket = 'mail_sent' AND key = 'site' AND window_start = ${START}`.execute(db);
  return rows[0]?.count ?? 0;
}
