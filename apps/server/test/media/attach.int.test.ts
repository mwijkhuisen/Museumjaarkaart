import { OwnReview } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMuseum } from '../reviews/app.ts';
import { openPhotos, type PhotosFixture } from './photos.ts';

// P3b WP5: `media_ids` on POST /reviews attach a member's own photos in one UPDATE whose row count must equal the
// list (else 422 and the whole create rolls back), a trusted author's finished photos queue `media_publish`, and
// deleting a review marks its photos removed and queues `media_delete`.

let f: PhotosFixture;
let nth = 400;
beforeAll(async () => {
  f = await openPhotos();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const jobs = async (kind: string, mediaId: string) =>
  (await f.p.owner.query('SELECT 1 FROM job WHERE kind = $1 AND payload->>$3 = $2', [kind, mediaId, 'media_id']))
    .rowCount;
const row = async (id: string) =>
  (
    await f.p.owner.query<{ review_id: string | null; state: string }>(
      'SELECT review_id, state FROM media WHERE id = $1',
      [id],
    )
  ).rows[0];
const reviewCount = async (userId: string) =>
  (await f.p.owner.query('SELECT 1 FROM review WHERE user_id = $1', [userId])).rowCount;

async function scene(opts: { trusted?: boolean } = {}) {
  const museum = await openMuseum(f.p, nth++);
  const me = await f.member(museum.id, opts);
  const photo = (state: Parameters<typeof f.photo>[0]['state'], over: { userId?: string; museumId?: string } = {}) =>
    f.photo({
      userId: over.userId ?? me.id,
      museumId: over.museumId ?? museum.id,
      state,
      ...(state === 'pending_review' ? { variants: [400] } : {}),
    });
  const create = (media_ids?: unknown, token = me.token) =>
    f.t.call('/reviews', {
      token,
      body: {
        museum_id: museum.id,
        visit_id: me.visitId,
        rating: 4,
        ...(media_ids === undefined ? {} : { media_ids }),
      },
    });
  return { museum, me, photo, create };
}

describe('media_ids on POST /reviews', () => {
  it('attaches the member’s own live photos of the museum and answers them', async () => {
    const s = await scene();
    const a = await s.photo('quarantined');
    const b = await s.photo('processing');
    const c = await s.photo('pending_review');
    const d = await s.photo('approved');
    const r = await s.create([a.id, b.id, c.id, d.id]);
    expect(r.status).toBe(201);
    const own = OwnReview.parse(await r.json());
    expect(own.photos.map((x) => [x.id, x.state]).sort()).toEqual(
      [a.id, b.id, c.id, d.id]
        .map((id, i) => [id, ['quarantined', 'processing', 'pending_review', 'approved'][i]])
        .sort(),
    );
    for (const x of [a, b, c, d]) expect((await row(x.id))?.review_id).toBe(own.id);
    // An untrusted author's photos queue no publish job (they wait for a moderator, P3c).
    for (const x of [a, b, c, d]) expect(await jobs('media_publish', x.id)).toBe(0);
  });

  it('works without media_ids and with an empty list', async () => {
    const s = await scene();
    const r = await s.create([]);
    expect(r.status).toBe(201);
    expect(OwnReview.parse(await r.json()).photos).toEqual([]);
  });

  it('queues media_publish for a trusted author’s photo that already finished processing, and only that one', async () => {
    const s = await scene({ trusted: true });
    const ready = await s.photo('pending_review');
    const busy = await s.photo('processing');
    const queued = await s.photo('quarantined');
    const done = await s.photo('approved');
    const r = await s.create([ready.id, busy.id, queued.id, done.id]);
    expect(r.status).toBe(201);
    expect(await jobs('media_publish', ready.id)).toBe(1);
    for (const x of [busy, queued, done]) expect(await jobs('media_publish', x.id)).toBe(0);
  });

  it('refuses with 422 ["media_ids"], creates no review and attaches nothing, for every wrong photo', async () => {
    const s = await scene();
    const other = await f.member(s.museum.id);
    const elsewhere = await openMuseum(f.p, nth++);
    const good = await s.photo('pending_review');
    const reviewOfOther = await f.review(other.id, s.museum.id, other.visitId);
    const bad: [string, string][] = [
      ['another member’s', (await s.photo('pending_review', { userId: other.id })).id],
      ['another museum’s', (await s.photo('pending_review', { museumId: elsewhere.id })).id],
      ['failed', (await s.photo('failed')).id],
      ['removed', (await s.photo('removed')).id],
      ['rejected', (await s.photo('rejected')).id],
      ['still uploading', (await s.photo('uploading')).id],
      [
        'already attached',
        (await f.photo({ userId: s.me.id, museumId: s.museum.id, reviewId: reviewOfOther, state: 'pending_review' }))
          .id,
      ],
      ['unknown', '0194f2c0-0000-7000-8000-00000000dead'],
    ];
    for (const [name, id] of bad) {
      const r = await s.create([good.id, id]);
      expect(r.status, name).toBe(422);
      expect(await r.json(), name).toEqual({ error: 'invalid', fields: ['media_ids'] });
      expect(await reviewCount(s.me.id), name).toBe(0);
      expect((await row(good.id))?.review_id, name).toBeNull();
      expect((await row(id))?.review_id ?? null, name).toBe(name === 'already attached' ? reviewOfOther : null);
    }
    // The same create with only the good photo still works: the refusals cost nothing.
    expect((await s.create([good.id])).status).toBe(201);
  });

  it('refuses an 11th photo, a duplicate and a value that is not a uuid, before any SQL', async () => {
    const s = await scene();
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await s.photo('quarantined')).id);
    const cases: [string, unknown][] = [
      ['eleven', ids],
      ['duplicate', [ids[0], ids[0]]],
      ['not a uuid', ['1; DROP TABLE media']],
      ['not a list', ids[0]],
      ['null element', [null]],
    ];
    for (const [name, v] of cases) {
      const r = await s.create(v);
      expect(r.status, name).toBe(422);
      expect(await r.json(), name).toEqual({ error: 'invalid', fields: ['media_ids'] });
    }
    expect(await reviewCount(s.me.id)).toBe(0);
    expect((await s.create(ids.slice(0, 10))).status).toBe(201);
  });

  it('cannot be used on PATCH /reviews: the field is unknown there', async () => {
    const s = await scene();
    const made = OwnReview.parse(await (await s.create()).json());
    const p = await s.photo('quarantined');
    const r = await f.t.call(`/reviews/${made.id}`, {
      method: 'PATCH',
      token: s.me.token,
      body: { media_ids: [p.id] },
    });
    expect(r.status).toBe(400);
    expect((await row(p.id))?.review_id).toBeNull();
  });
});

describe('DELETE /reviews/:id with photos', () => {
  it('marks the review’s photos removed, queues media_delete for each and leaves a failed one alone', async () => {
    const s = await scene();
    const photos = [await s.photo('pending_review'), await s.photo('approved'), await s.photo('quarantined')];
    const made = OwnReview.parse(await (await s.create(photos.map((x) => x.id))).json());
    const failed = await f.photo({ userId: s.me.id, museumId: s.museum.id, reviewId: made.id, state: 'failed' });
    const stranger = await f.member(s.museum.id);

    // Another member's delete is a 404 and touches nothing.
    expect((await f.t.call(`/reviews/${made.id}`, { method: 'DELETE', token: stranger.token })).status).toBe(404);
    for (const x of photos) expect((await row(x.id))?.state).not.toBe('removed');

    expect((await f.t.call(`/reviews/${made.id}`, { method: 'DELETE', token: s.me.token })).status).toBe(204);
    for (const x of photos) {
      expect((await row(x.id))?.state, x.id).toBe('removed');
      expect(await jobs('media_delete', x.id), x.id).toBe(1);
    }
    expect((await row(failed.id))?.state).toBe('failed');
    expect(await jobs('media_delete', failed.id)).toBe(0);
    expect(await reviewCount(s.me.id)).toBe(0);
    // The public photo list lost the approved photo with its review.
    expect(await (await f.t.call(`/museums/${s.museum.slug}/photos`)).text()).not.toContain(photos[1]?.id);
  });

  it('rolls the photos back with the delete when the review is not the member’s', async () => {
    const s = await scene();
    const p = await s.photo('quarantined');
    const made = OwnReview.parse(await (await s.create([p.id])).json());
    const stranger = await f.member(s.museum.id);
    await f.t.call(`/reviews/${made.id}`, { method: 'DELETE', token: stranger.token });
    expect(await row(p.id)).toEqual({ review_id: made.id, state: 'quarantined' });
    expect(await jobs('media_delete', p.id)).toBe(0);
  });
});
