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
import { BUCKETS, enforce, hit } from '../../auth/limiter.ts';
import { parseCsv } from '../../passport/import/csv.ts';
import { type ImportMuseum, loadMuseums, matchRows } from '../../passport/import/match.ts';
import { parseMjk } from '../../passport/import/mjk.ts';
import type { ParseResult } from '../../passport/import/types.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
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
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid';
  error: ImportPreview['rows'][number]['error'];
  museum_id: string | null;
  candidate_ids: string[];
};

const toMuseum = (m: ImportMuseum): VisitMuseum => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  name_en: m.name_en,
  place: m.place,
});

export function mountMeImports(v1: ApiApp, deps: ApiDeps): void {
  const { db, logger } = deps;

  v1.post('/me/imports', async (c) => {
    const session = requireMember(c);
    const userId = session.user.id;
    enforce(logger, BUCKETS.importUserHour, await hit(db, BUCKETS.importUserHour, userId));
    const body = await readJson(c, ImportRequest);
    // Museotrack's and Cultra's parsers come after A10.
    if (body.format === 'museotrack' || body.format === 'cultra') throw new ApiError('invalid', ['format']);
    const parsed: ParseResult =
      body.format === 'csv' ? parseCsv(body.content, todayAmsterdam()) : parseMjk(body.content, todayAmsterdam());
    if (!parsed.ok) throw new ApiError(parsed.error === 'too_many_rows' ? 'too_large' : 'invalid', ['content']);

    const museums = await loadMuseums(db);
    const matches = matchRows(parsed.rows, museums);
    const stored: StoredRow[] = parsed.rows.map((r, i) => {
      const m = matches[i] as (typeof matches)[number];
      return {
        row: r.row,
        kind: r.kind,
        name: r.ref.name,
        place: r.ref.place,
        visited_on: r.visited_on,
        note: r.note,
        status: m.status,
        error: r.error,
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
      for (const r of rows) {
        if (r.status === 'invalid' || skip.has(r.row)) continue;
        const museumId = chosen.get(r.row) ?? (r.status === 'matched' ? r.museum_id : null);
        if (museumId === null || !visible.has(museumId)) continue;
        if (r.kind === 'visit') {
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
      return {
        visits: insertedVisits,
        wishlist: insertedWishlist,
        skipped: visits.length + wishlist.length - insertedVisits - insertedWishlist,
      };
    });
    return sendJson(c, ImportResult, result, CACHE_PRIVATE);
  });
}
