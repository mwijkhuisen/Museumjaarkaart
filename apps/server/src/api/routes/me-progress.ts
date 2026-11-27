import { EmptyQuery, MeProgress } from '@mjk/contracts';
import { todayAmsterdam } from '../../admin/dates.ts';
import { settingsOf } from '../../auth/me.ts';
import { memberProgress } from '../../passport/progress.ts';
import { memberSavings } from '../../passport/savings.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { requireMember } from '../middleware/session.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

/** GET /me/progress: the member's progress against the card list, per year, and € saved (A§10). Keyed on the session's user. */
export function mountMeProgress(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;
  v1.get('/me/progress', async (c) => {
    const session = requireMember(c);
    parseQuery(c, EmptyQuery);
    const { id, settings } = session.user;
    const [progress, savings] = await Promise.all([
      memberProgress(db, id),
      memberSavings(db, id, settingsOf(settings).card_type, todayAmsterdam()),
    ]);
    return sendJson(c, MeProgress, { progress, savings }, CACHE_PRIVATE);
  });
}
