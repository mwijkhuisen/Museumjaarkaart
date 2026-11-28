import { EmptyQuery, MediaAltPatch, MediaIdParam, OwnPhoto, PreviewQuery } from '@mjk/contracts';
import type { Context } from 'hono';
import { QUARANTINE_DIR } from '../../media/limits.ts';
import { readPreview } from '../../media/preview.ts';
import { ownPhoto } from '../../media/public.ts';
import { markRemoved } from '../../media/remove.ts';
import { ownUpload } from '../../media/uploads.ts';
import type { ApiApp, ApiDeps } from '../app.ts';
import { readJson } from '../body.ts';
import { CACHE_PRIVATE } from '../cache.ts';
import { ApiError } from '../errors.ts';
import type { ApiEnv } from '../middleware/request.ts';
import { requireMember, requirePoster } from '../middleware/session.ts';
import { parseQuery } from '../query.ts';
import { sendJson } from '../respond.ts';

// The member's own photo routes (A§12, A§14, P3b WP5): the preview of a photo that waits for review, its alt
// text and its removal. Every query is keyed on the session's user, so another member's photo is a 404, never
// a 403. The preview is the one route that reads quarantine for a reader; none reads the originals.

const mediaId = (raw: string | undefined): string => {
  const parsed = MediaIdParam.safeParse(raw);
  if (!parsed.success) throw new ApiError('not_found');
  return parsed.data;
};

/** The alt-text body; a text the rule refuses is a 422 `["alt_text"]` (the member's text is at fault, not the shape). */
async function readAlt(c: Context<ApiEnv>) {
  try {
    return await readJson(c, MediaAltPatch);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'bad_request' && err.fields?.join() === 'alt_text')
      throw new ApiError('invalid', ['alt_text']);
    throw err;
  }
}

export function mountMedia(v1: ApiApp, deps: ApiDeps): void {
  const { db } = deps;
  const root = deps.quarantineDir ?? QUARANTINE_DIR;

  // 404 for everything that is not the author's own photo waiting for review, an anonymous request included, so
  // the route confirms nothing about which ids exist or in which state.
  v1.get('/uploads/:id/preview', async (c) => {
    const session = c.get('session');
    const id = mediaId(c.req.param('id'));
    const q = parseQuery(c, PreviewQuery);
    if (session === undefined) throw new ApiError('not_found');
    const upload = await ownUpload(db, session.user.id, id);
    if (upload === undefined || upload.state !== 'pending_review') throw new ApiError('not_found');
    const bytes = await readPreview(root, upload, Number(q.w));
    if (bytes === undefined) throw new ApiError('not_found');
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'image/webp',
      'Cache-Control': CACHE_PRIVATE,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  // The alt text of one's own photo, in any live state; a text the rule refuses is a 422 `["alt_text"]`.
  v1.patch('/media/:id', async (c) => {
    const userId = requirePoster(c).user.id;
    const id = mediaId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    const patch = await readAlt(c);
    const done = await db
      .updateTable('media')
      .set({ alt_text: patch.alt_text })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('state', 'not in', ['removed', 'failed'])
      .returning('id')
      .executeTakeFirst();
    const photo = done === undefined ? undefined : await ownPhoto(db, userId, id);
    if (photo === undefined) throw new ApiError('not_found');
    return sendJson(c, OwnPhoto, photo, CACHE_PRIVATE);
  });

  // Allowed without the current terms (it removes content); the worker's `media_delete` takes the files.
  v1.delete('/media/:id', async (c) => {
    const userId = requireMember(c).user.id;
    const id = mediaId(c.req.param('id'));
    parseQuery(c, EmptyQuery);
    await db.transaction().execute(async (trx) => {
      const own = await trx
        .selectFrom('media')
        .select('id')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (own === undefined || (await markRemoved(trx, [id])).length === 0) throw new ApiError('not_found');
    });
    c.header('Cache-Control', CACHE_PRIVATE);
    return c.body(null, 204);
  });
}
