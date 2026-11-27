import { type RawBuilder, sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';

// The retention purge (A§13.2), every 10 minutes, as mjk_worker, on the database clock. Counts only in the
// log (invariant 8). audit_log is never touched here (its purge function comes in P3c).

const STEPS: Record<string, RawBuilder<unknown>> = {
  session: sql`DELETE FROM session WHERE expires_at < now() OR absolute_expires_at < now()`,
  email_code: sql`DELETE FROM email_code WHERE created_at < now() - interval '24 hours'`,
  // A minute of grace past the expiry: a spend checks the expiry with its own statement's clock, so a
  // replay that starts just before a purge can never find the spent row already gone (P2b review L4).
  auth_challenge: sql`DELETE FROM auth_challenge WHERE expires_at < now() - interval '1 minute'`,
  rate_limit: sql`DELETE FROM rate_limit WHERE window_end < now() - interval '24 hours'`,
  job: sql`DELETE FROM job WHERE state IN ('done', 'failed') AND finished_at < now() - interval '30 days'`,
  // A§9: an unsent sealed code is nulled at its expiry (10 minutes); a failed mail job keeps no sealed value.
  sealed_code: sql`UPDATE job SET payload = payload || '{"sealed": null}'::jsonb
    WHERE kind = 'mail_code' AND state <> 'running' AND payload -> 'sealed' <> 'null'::jsonb
      AND (state = 'failed' OR created_at < now() - interval '10 minutes')`,
  sealed_failed: sql`UPDATE job SET payload = payload
      || CASE kind WHEN 'mail_invite' THEN '{"sealed_code": null, "sealed_to": null}'::jsonb
                   ELSE '{"sealed_to": null}'::jsonb END
    WHERE kind IN ('mail_invite', 'mail_notice') AND state = 'failed'
      AND (payload -> 'sealed_to' <> 'null'::jsonb OR payload -> 'sealed_code' <> 'null'::jsonb)`,
  invite: sql`DELETE FROM invite WHERE expires_at < now() - interval '90 days'
    OR (uses >= max_uses AND used_at < now() - interval '90 days')`,
  content_ip_log: sql`DELETE FROM content_ip_log WHERE created_at < now() - interval '30 days'`,
  // A§10: the parsed rows of an import wait at most 7 days, confirmed or not (P2c pulls this forward from P3d).
  visit_import: sql`DELETE FROM visit_import WHERE created_at < now() - interval '7 days'`,
};

export async function purge(db: Db, logger: Logger): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, stmt] of Object.entries(STEPS)) {
    counts[name] = Number((await stmt.execute(db)).numAffectedRows ?? 0);
  }
  logger.info(counts, 'purge_done');
  return counts;
}
