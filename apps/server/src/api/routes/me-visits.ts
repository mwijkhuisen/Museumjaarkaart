import { BulkResult, BulkVisits, Visit, VisitCreate, VisitList, VisitListQuery, VisitPatch } from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { InvalidVisitCursor, visitById, visitDateOk, visitPage } from '../../passport/visits.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's visit log (A§10, A§14): list, add, edit, delete and the onboarding bulk tick. Every query is
// keyed on the session's user, so another member's visit is a 404, never a 403. Notes are never logged.

const UNIQUE_VIOLATION = '23505';
// ON DELETE RESTRICT raises 23001 (NO ACTION would raise 23503), pinned in test/reviews/schema.int.test.ts.
const RESTRICT_VIOLATION = '23001';
const FK_VIOLATION = '23503';
const CITED_VISIT = 'review_cites_own_visit';
const sqlstate = (err: unknown): string | undefined => (err as { code?: unknown }).code as string | undefined;

export function mountMeVisits(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;

  v1.get('/me/visits', async (c) => {
    const session = requireMember(c);
    const q = parseQuery(c, VisitListQuery);
    try {
      return sendJson(c, VisitList, await visitPage(db, session.user.id, q.cursor, q.limit), CACHE_PRIVATE);
    } catch (err) {
      if (err instanceof InvalidVisitCursor) throw new ApiError('bad_request', ['cursor']);
      throw err;
    }
  });

  v1.post('/me/visits', async (c) => {
    const session = requireMember(c);
    const body = await readJson(c, VisitCreate);
    if (body.visited_on !== null && !visitDateOk(body.visited_on)) throw new ApiError('invalid', ['visited_on']);
    const userId = session.user.id;
    const museum = await sql`SELECT 1 FROM museum WHERE id = ${body.museum_id}::uuid AND NOT hidden`.execute(db);
    if (museum.rows.length === 0) throw new ApiError('invalid', ['museum_id']);
    // The unique constraint answers a duplicate (same museum and date, undated included) with no row, not an error.
    const { rows } = await sql<{ id: string }>`INSERT INTO visit (user_id, museum_id, visited_on, note, source)
      VALUES (${userId}::uuid, ${body.museum_id}::uuid, ${body.visited_on}::date, ${body.note ?? null}, 'manual')
      ON CONFLICT ON CONSTRAINT visit_once DO NOTHING RETURNING id`.execute(db);
    const id = rows[0]?.id;
    if (id === undefined) throw new ApiError('conflict');
    const visit = await visitById(db, userId, id);
    if (visit === undefined) throw new Error('visit_vanished');
    return sendJson(c, Visit, visit, CACHE_PRIVATE, 201);
  });

  // Registered before /me/visits/:id; the method differs anyway.
  v1.post('/me/visits/bulk', async (c) => {
    const session = requireMember(c);
    const body = await readJson(c, BulkVisits);
    const ids = [...new Set(body.museum_ids.map((id) => id.toLowerCase()))];
    const userId = session.user.id;
    // A museum the member has any visit to, dated or not, gets none; a hidden one gets none.
    const { rows } = await sql<{ id: string }>`INSERT INTO visit (user_id, museum_id, source)
      SELECT ${userId}::uuid, m.id, 'bulk' FROM museum m
       WHERE m.id = ANY(${ids}::uuid[]) AND NOT m.hidden
         AND NOT EXISTS (SELECT 1 FROM visit v WHERE v.user_id = ${userId}::uuid AND v.museum_id = m.id)
      ON CONFLICT ON CONSTRAINT visit_once DO NOTHING RETURNING id`.execute(db);
    return sendJson(c, BulkResult, { added: rows.length, skipped: ids.length - rows.length }, CACHE_PRIVATE);
  });

  v1.patch('/me/visits/:id', async (c) => {
    const session = requireMember(c);
    const id = parseParam('id', c.req.param('id'), z.uuid());
    const body = await readJson(c, VisitPatch);
    if (body.visited_on != null && !visitDateOk(body.visited_on)) throw new ApiError('invalid', ['visited_on']);
    const userId = session.user.id;
    // mjk_api may update only visited_on and note; an omitted field stays as it is.
    const set = {
      ...(body.visited_on === undefined ? {} : { visited_on: body.visited_on }),
      ...(body.note === undefined ? {} : { note: body.note }),
    };
    try {
      await db.transaction().execute(async (trx) => {
        // PostgreSQL 18's RETURNING old/new: whether the date moved, decided under the visit's row lock.
        const done = await trx
          .updateTable('visit')
          .set(set)
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .returning(sql<boolean>`old.visited_on IS DISTINCT FROM new.visited_on`.as('moved'))
          .executeTakeFirst();
        if (done === undefined) throw new ApiError('not_found');
        // The date a review shows is part of its content (A§11 Edits): the member's review citing it is edited.
        if (done.moved)
          await trx
            .updateTable('review')
            .set({ edited_at: sql<Date>`now()` })
            .where('visit_id', '=', id)
            .where('user_id', '=', userId)
            .execute();
      });
    } catch (err) {
      if (sqlstate(err) === UNIQUE_VIOLATION) throw new ApiError('conflict');
      throw err;
    }
    const visit = await visitById(db, userId, id);
    if (visit === undefined) throw new ApiError('not_found');
    return sendJson(c, Visit, visit, CACHE_PRIVATE);
  });

  // A visit that a review cites cannot go (P3a): the member deletes the review or cites another visit first.
  // The NOT EXISTS decides in SQL, so the normal flow raises no database error; the foreign key
  // (review_cites_own_visit, RESTRICT) is the backstop for a review created at the same moment.
  v1.delete('/me/visits/:id', async (c) => {
    const session = requireMember(c);
    const id = parseParam('id', c.req.param('id'), z.uuid());
    const userId = session.user.id;
    let gone: { id: string } | undefined;
    try {
      const { rows } = await sql<{ id: string }>`DELETE FROM visit
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
          AND NOT EXISTS (SELECT 1 FROM review r WHERE r.visit_id = visit.id)
        RETURNING id`.execute(db);
      gone = rows[0];
    } catch (err) {
      const constraint = (err as { constraint?: unknown }).constraint;
      if (sqlstate(err) === RESTRICT_VIOLATION || (sqlstate(err) === FK_VIOLATION && constraint === CITED_VISIT))
        throw new ApiError('conflict');
      throw err;
    }
    if (gone === undefined) {
      const own = await sql`SELECT 1 FROM visit WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`.execute(db);
      throw new ApiError(own.rows.length > 0 ? 'conflict' : 'not_found');
    }
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });
}
