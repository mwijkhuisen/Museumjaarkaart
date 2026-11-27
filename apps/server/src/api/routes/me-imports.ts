import {
  ImportConfirm,
  type ImportPreview,
  ImportPreview as ImportPreviewSchema,
  ImportRequest,
  ImportResult,
  type VisitMuseum,
} from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { todayAmsterdam } from '../../admin/dates.ts';
import { BUCKETS, enforce, hit, userKey } from '../../auth/limiter.ts';
import type { Db } from '../../db/kysely.ts';
import { NL_TODAY } from '../../museums/near.ts';
import { parseCsv } from '../../passport/import/csv.ts';
import { type ImportMuseum, loadMuseums, matchRows } from '../../passport/import/match.ts';
import { parseMjk } from '../../passport/import/mjk.ts';
import type { ParseResult } from '../../passport/import/types.ts';
import { createReview } from '../../reviews/service.ts';
import { enqueueStats } from '../../reviews/stats-queue.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { clientOr429 } from '../middleware/client-address.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's imports (A§10, plan Q3): upload and preview, then confirm. The file itself is never stored,
// only the parsed rows with their match (`visit_import.rows`, purged after 7 days). Nothing ambiguous or
// unmatched applies unless the member chooses a museum for that row.

const UNIQUE_VIOLATION = '23505';

/** What `visit_import.rows` holds per row. */
type StoredRow = {
  row: number;
  kind: 'visit' | 'wishlist';
  name: string | null;
  place: string | null;
  visited_on: string | null;
  note: string | null;
  rating?: number | null;
  review?: string | null;
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid';
  error: ImportPreview['rows'][number]['error'];
  museum_id: string | null;
  candidate_ids: string[];
};

/**
 * One rated row in its own savepoint: the visit (the existing one by `visit_once`'s key, or a new one), then the
 * review. A refusal, a lost race or a database error rolls the savepoint back, so a new visit goes with it and
 * nothing of the row applies (null). No rate-limit hit (plan Q7); one `content_ip_log` row per review.
 */
async function applyRated(
  trx: Db,
  userId: string,
  museumId: string,
  r: StoredRow,
  client: { address: string } | undefined,
): Promise<{ newVisit: boolean } | null> {
  await sql`SAVEPOINT import_row`.execute(trx);
  try {
    const inserted = await trx
      .insertInto('visit')
      .values({ user_id: userId, museum_id: museumId, visited_on: r.visited_on, note: r.note, source: 'import' })
      .onConflict((oc) => oc.constraint('visit_once').doNothing())
      .returning('id')
      .executeTakeFirst();
    const visitId =
      inserted?.id ??
      (
        await sql<{ id: string }>`SELECT id FROM visit WHERE user_id = ${userId}::uuid AND museum_id = ${museumId}::uuid
          AND visited_on IS NOT DISTINCT FROM ${r.visited_on}::date`.execute(trx)
      ).rows[0]?.id;
    const made =
      visitId === undefined || client === undefined || r.rating == null
        ? null
        : await createReview(trx, userId, {
            museum_id: museumId,
            visit_id: visitId,
            rating: r.rating,
            body: r.review ?? null,
          });
    if (made === null || !made.ok) {
      await sql`ROLLBACK TO SAVEPOINT import_row`.execute(trx);
      return null;
    }
    await trx
      .insertInto('content_ip_log')
      .values({ user_id: userId, target_kind: 'review', target_id: made.id, ip: client?.address as string })
      .execute();
    await sql`RELEASE SAVEPOINT import_row`.execute(trx);
    return { newVisit: inserted !== undefined };
  } catch {
    await sql`ROLLBACK TO SAVEPOINT import_row`.execute(trx);
    return null;
  }
}

const toMuseum = (m: ImportMuseum): VisitMuseum => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  name_en: m.name_en,
  place: m.place,
});

/**
 * The rated rows (matched, valid) that cannot become a review, by row: the second rated row for a museum in
 * the file (the first stands), a review the member already has (any state: `review_once`) and a closed museum.
 * Ambiguous and unmatched rows are judged at confirm, when the member has chosen. ponytail: the confirm's
 * createReview is the authority; this is the preview's early word.
 */
async function refusedRatings(
  db: Db,
  userId: string,
  rated: { row: number; museumId: string }[],
): Promise<Map<number, 'review_exists' | 'museum_closed'>> {
  const out = new Map<number, 'review_exists' | 'museum_closed'>();
  if (rated.length === 0) return out;
  const ids = [...new Set(rated.map((r) => r.museumId))];
  const had = new Set(
    (
      await db
        .selectFrom('review')
        .select('museum_id')
        .where('user_id', '=', userId)
        .where('museum_id', 'in', ids)
        .execute()
    ).map((r) => r.museum_id),
  );
  const closed = new Set(
    (
      await sql<{ id: string }>`SELECT id FROM museum WHERE id IN (${sql.join(ids)}) AND closed_on IS NOT NULL
        AND closed_on <= ${NL_TODAY}`.execute(db)
    ).rows.map((r) => r.id),
  );
  const seen = new Set<string>();
  for (const { row, museumId } of rated) {
    if (closed.has(museumId)) out.set(row, 'museum_closed');
    else if (had.has(museumId) || seen.has(museumId)) out.set(row, 'review_exists');
    else seen.add(museumId);
  }
  return out;
}

export function mountMeImports(v1: ApiApp, deps: ApiDeps): void {
  const { db, logger, keys } = deps;
  if (keys === undefined) throw new Error('me_imports_need_keys');

  v1.post('/me/imports', async (c) => {
    const session = requireMember(c);
    const userId = session.user.id;
    enforce(logger, BUCKETS.importUserHour, await hit(db, BUCKETS.importUserHour, userKey(keys, 'import', userId)));
    const body = await readJson(c, ImportRequest);
    // Museotrack's and Cultra's parsers come after A10.
    if (body.format === 'museotrack' || body.format === 'cultra') throw new ApiError('invalid', ['format']);
    const parsed: ParseResult =
      body.format === 'csv' ? parseCsv(body.content, todayAmsterdam()) : parseMjk(body.content, todayAmsterdam());
    if (!parsed.ok) throw new ApiError(parsed.error === 'too_many_rows' ? 'too_large' : 'invalid', ['content']);

    const museums = await loadMuseums(db);
    const matches = matchRows(parsed.rows, museums);
    const refused = await refusedRatings(
      db,
      userId,
      parsed.rows.flatMap((r, i) => {
        const m = matches[i] as (typeof matches)[number];
        return r.rating !== null && r.error === null && m.status === 'matched' && m.museumId !== null
          ? [{ row: r.row, museumId: m.museumId }]
          : [];
      }),
    );
    const stored: StoredRow[] = parsed.rows.map((r, i) => {
      const m = matches[i] as (typeof matches)[number];
      const refusal = refused.get(r.row);
      return {
        row: r.row,
        kind: r.kind,
        name: r.ref.name,
        place: r.ref.place,
        visited_on: r.visited_on,
        note: r.note,
        rating: r.rating,
        review: r.review,
        status: refusal === undefined ? m.status : 'invalid',
        error: refusal ?? r.error,
        museum_id: m.museumId,
        candidate_ids: m.candidateIds,
      };
    });
    let id: string;
    try {
      id = await db.transaction().execute(async (trx) => {
        // A new import replaces the member's pending one.
        await trx.deleteFrom('visit_import').where('user_id', '=', userId).where('state', '=', 'pending').execute();
        const row = await trx
          .insertInto('visit_import')
          .values({ user_id: userId, format: body.format, rows: JSON.stringify(stored) })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      });
    } catch (err) {
      // Two uploads at once: the other one holds the member's pending slot.
      if ((err as { code?: unknown }).code === UNIQUE_VIOLATION) throw new ApiError('conflict');
      throw err;
    }

    const byId = new Map(museums.map((m) => [m.id, m]));
    const museumOf = (mid: string | null) => {
      const m = mid === null ? undefined : byId.get(mid);
      return m === undefined ? null : toMuseum(m);
    };
    const counts = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
    for (const r of stored) counts[r.status]++;
    return sendJson(
      c,
      ImportPreviewSchema,
      {
        id,
        format: body.format,
        rows: stored.map((r) => ({
          row: r.row,
          kind: r.kind,
          name: r.name,
          place: r.place,
          visited_on: r.visited_on,
          note: r.note,
          rating: r.rating ?? null,
          review: r.review ?? null,
          status: r.status,
          error: r.error,
          museum: museumOf(r.museum_id),
          candidates: r.candidate_ids.flatMap((cid) => museumOf(cid) ?? []),
        })),
        counts,
      },
      CACHE_PRIVATE,
      201,
    );
  });

  v1.post('/me/imports/:id/confirm', async (c) => {
    const session = requireMember(c);
    const userId = session.user.id;
    const id = parseParam('id', c.req.param('id'), z.uuid());
    const body = await readJson(c, ImportConfirm);

    const result = await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable('visit_import')
        .set({ state: 'confirmed', confirmed_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('state', '=', 'pending')
        .returning('rows')
        .executeTakeFirst();
      if (claimed === undefined) {
        // The member's own confirmed import is a second confirm; anything else is not theirs or not there.
        const own = await trx
          .selectFrom('visit_import')
          .select('id')
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        throw new ApiError(own === undefined ? 'not_found' : 'conflict');
      }
      const rows = claimed.rows as StoredRow[];
      // A file with ratings logs the client address once per review: without one, 429 and the import stays pending.
      const client = rows.some((r) => r.status !== 'invalid' && (r.rating ?? null) !== null)
        ? clientOr429(c, logger, BUCKETS.importUserHour)
        : undefined;
      const byRow = new Map(rows.map((r) => [r.row, r]));

      const chosen = new Map<number, string>();
      for (const { row, museum_id } of body.choose) {
        const r = byRow.get(row);
        if (r === undefined || r.status === 'invalid' || chosen.has(row)) throw new ApiError('invalid', ['choose']);
        chosen.set(row, museum_id);
      }
      const skip = new Set(body.skip);
      for (const row of skip) if (!byRow.has(row)) throw new ApiError('invalid', ['skip']);
      for (const row of chosen.keys()) if (skip.has(row)) throw new ApiError('invalid', ['choose', 'skip']);

      // A chosen museum must be visible now; a matched one that was hidden since the preview just drops out.
      const wanted = [
        ...new Set([...chosen.values(), ...rows.flatMap((r) => (r.museum_id === null ? [] : [r.museum_id]))]),
      ];
      const visible = new Set(
        wanted.length === 0
          ? []
          : (
              await trx
                .selectFrom('museum')
                .select('id')
                .where('id', 'in', wanted)
                .where('hidden', '=', false)
                .execute()
            ).map((m) => m.id),
      );
      for (const mid of chosen.values()) if (!visible.has(mid)) throw new ApiError('invalid', ['choose']);

      const visits: {
        user_id: string;
        museum_id: string;
        visited_on: string | null;
        note: string | null;
        source: 'import';
      }[] = [];
      const wishlist: { user_id: string; museum_id: string }[] = [];
      const rated: { row: StoredRow; museumId: string }[] = [];
      for (const r of rows) {
        if (r.status === 'invalid' || skip.has(r.row)) continue;
        const museumId = chosen.get(r.row) ?? (r.status === 'matched' ? r.museum_id : null);
        if (museumId === null || !visible.has(museumId)) continue;
        if (r.kind === 'visit' && (r.rating ?? null) !== null) rated.push({ row: r, museumId });
        else if (r.kind === 'visit') {
          visits.push({
            user_id: userId,
            museum_id: museumId,
            visited_on: r.visited_on,
            note: r.note,
            source: 'import',
          });
        } else wishlist.push({ user_id: userId, museum_id: museumId });
      }

      // Importing the same file twice adds nothing: visit_once also collides two undated visits.
      const insertedVisits =
        visits.length === 0
          ? 0
          : (
              await trx
                .insertInto('visit')
                .values(visits)
                .onConflict((oc) => oc.constraint('visit_once').doNothing())
                .returning('id')
                .execute()
            ).length;
      const insertedWishlist =
        wishlist.length === 0
          ? 0
          : (
              await trx
                .insertInto('wishlist')
                .values(wishlist)
                .onConflict((oc) => oc.doNothing())
                .returning('museum_id')
                .execute()
            ).length;
      // A rated row is all or nothing: its visit (new or already there) and its review, inside a savepoint.
      let insertedReviews = 0;
      let ratedVisits = 0;
      let ratedSkipped = 0;
      for (const { row: r, museumId } of rated) {
        const done = await applyRated(trx, userId, museumId, r, client);
        if (done === null) ratedSkipped++;
        else {
          insertedReviews++;
          if (done.newVisit) ratedVisits++;
        }
      }
      if (insertedReviews > 0) await enqueueStats(trx);
      return {
        visits: insertedVisits + ratedVisits,
        wishlist: insertedWishlist,
        reviews: insertedReviews,
        skipped: visits.length + wishlist.length - insertedVisits - insertedWishlist + ratedSkipped,
      };
    });
    return sendJson(c, ImportResult, result, CACHE_PRIVATE);
  });
}
