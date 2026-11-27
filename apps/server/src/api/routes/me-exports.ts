import { EmptyQuery, ExportFile, ExportItem, ExportList } from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { BUCKETS, enforce, hit, userKey } from '../../auth/limiter.ts';
import { EXPORT_FILES, readBundleFile } from '../../passport/export/files.ts';
import { DATA_EXPORT_JOB } from '../../passport/export/job.ts';
import { enqueueIn } from '../../worker/queue.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import { requireMember } from '../middleware/session.ts';
import { parseParam, parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's data export (A§10, P2c owner decisions): request it, list it, download it in the member's own
// session for 24 h [U]. No signed link: the mail points at the account page, and the download checks the
// session, the owner, the state and the expiry. One open export per member, at most 3 a day (Q5).

const UNIQUE_VIOLATION = '23505';

const CONTENT_TYPE: Readonly<Record<ExportFile, string>> = {
  'export.json': 'application/json; charset=utf-8',
  'visits.csv': 'text/csv; charset=utf-8',
  'wishlist.csv': 'text/csv; charset=utf-8',
};

type Row = { id: string; state: ExportItem['state']; created_at: Date; expires_at: Date | null; live: boolean };

const toItem = (r: Row): ExportItem => ({
  id: r.id,
  state: r.state,
  created_at: r.created_at.toISOString(),
  expires_at: r.expires_at === null ? null : r.expires_at.toISOString(),
  files: r.live ? [...EXPORT_FILES] : [],
});

export function mountMeExports(v1: ApiApp, deps: ApiDeps): void {
  const { db, logger, keys } = deps;
  if (keys === undefined) throw new Error('me_exports_need_keys');

  v1.post('/me/exports', async (c) => {
    const userId = requireMember(c).user.id;
    parseQuery(c, EmptyQuery);
    let row: Row;
    try {
      row = await db.transaction().execute(async (trx) => {
        // A job that never finished does not block the member for long (the purge does the same).
        await trx
          .updateTable('data_export')
          .set({ state: 'failed' })
          .where('user_id', '=', userId)
          .where('state', '=', 'queued')
          .where('created_at', '<', sql<Date>`now() - interval '1 hour'`)
          .execute();
        const open = await trx
          .selectFrom('data_export')
          .select('id')
          .where('user_id', '=', userId)
          .where('state', '=', 'queued')
          .executeTakeFirst();
        if (open !== undefined) throw new ApiError('conflict');
        enforce(logger, BUCKETS.exportUserDay, await hit(trx, BUCKETS.exportUserDay, userKey(keys, 'export', userId)));
        const inserted = await trx
          .insertInto('data_export')
          .values({ user_id: userId })
          .returning(['id', 'state', 'created_at', 'expires_at'])
          .executeTakeFirstOrThrow();
        await enqueueIn(trx, DATA_EXPORT_JOB, { export_id: inserted.id }, {});
        return { ...inserted, state: 'queued' as const, live: false };
      });
    } catch (err) {
      // Two requests at once: the partial unique index lets one queued row through.
      if ((err as { code?: unknown }).code === UNIQUE_VIOLATION) throw new ApiError('conflict');
      throw err;
    }
    return sendJson(c, ExportItem, toItem(row), CACHE_PRIVATE, 202);
  });

  v1.get('/me/exports', async (c) => {
    const userId = requireMember(c).user.id;
    parseQuery(c, EmptyQuery);
    const { rows } = await sql<Row>`SELECT id, state, created_at, expires_at,
        (state = 'ready' AND expires_at > now()) AS live
        FROM data_export WHERE user_id = ${userId}::uuid
       ORDER BY created_at DESC, id DESC LIMIT 50`.execute(db);
    return sendJson(c, ExportList, { items: rows.map(toItem) }, CACHE_PRIVATE);
  });

  v1.get('/me/exports/:id/:file', async (c) => {
    const userId = requireMember(c).user.id;
    const id = parseParam('id', c.req.param('id'), z.uuid());
    const file = ExportFile.safeParse(c.req.param('file'));
    parseQuery(c, EmptyQuery);
    if (!file.success) throw new ApiError('not_found');
    // Another member's export, an unknown one, one not ready or expired: all the same 404.
    const own = await sql`SELECT 1 FROM data_export
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND state = 'ready' AND expires_at > now()`.execute(db);
    if (own.rows.length === 0) throw new ApiError('not_found');
    if (deps.exportsDir === undefined) throw new ApiError('unavailable');
    // The path is built from the validated uuid and the enum only.
    const body = await readBundleFile(deps.exportsDir, id, file.data);
    if (body === undefined) throw new ApiError('not_found');
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': CONTENT_TYPE[file.data],
      'Content-Disposition': `attachment; filename="${file.data}"`,
      'Cache-Control': CACHE_PRIVATE,
    });
  });
}
