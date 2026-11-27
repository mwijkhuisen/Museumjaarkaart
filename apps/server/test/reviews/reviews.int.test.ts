import { OwnReview, PublicReview, ReviewList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { closedMuseum, memberWithVisit, openMuseum, reviewsApp } from './app.ts';
import { addReview, memberWithReview } from './fixtures.ts';

// P3a WP3 (criteria 1, 2, 5, 6): the review routes over the seeded catalogue, as the api serves them (the
// writes as mjk_api) and as ssr does (the public reads as mjk_ssr).

let p: PassportDb;
let t: ReturnType<typeof reviewsApp>;
beforeAll(async () => {
  p = await openPassportDb();
  t = reviewsApp(p);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

let nth = 0;
const fresh = () => openMuseum(p, 300 + nth++);
const count = async (sql: string, params: unknown[] = []) =>
  Number((await p.admin.query<{ n: string }>(sql, params)).rows[0]?.n);

describe('POST /reviews', () => {
  it('creates a review with the aspects and the normalised body, answers the OwnReview with the visit date', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id, { on: '2026-03-14' });
    const r = await t.call('/reviews', {
      token: u.token,
      body: {
        museum_id: m.id,
        visit_id: u.visitId,
        rating: 4,
        kid_friendly: 5,
        facilities: null,
        body: '  Mooi.\r\nTwee\t  ',
      },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const own = OwnReview.parse(await r.json());
    expect(own).toMatchObject({
      museum_id: m.id,
      visit_id: u.visitId,
      visited_on: '2026-03-14',
      rating: 4,
      kid_friendly: 5,
      facilities: null,
      collection: null,
      body: 'Mooi.\nTwee',
      edited_at: null,
    });
    const row = (await p.admin.query('SELECT user_id, state, body FROM review WHERE id = $1', [own.id])).rows[0];
    expect(row).toMatchObject({ user_id: u.id, state: 'visible', body: 'Mooi.\nTwee' });
  });

  it('an empty or blank body is stored as null; a rating alone saves; an undated visit gives visited_on null', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id, { on: null });
    const r = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 2, body: '  \n ' },
    });
    expect(r.status).toBe(201);
    expect(OwnReview.parse(await r.json())).toMatchObject({ body: null, visited_on: null, rating: 2 });
  });

  it('refuses: unknown or hidden museum → 422 museum_id, not your visit → 422 visit_id, strict body → 400', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    const hidden = await p.hidden();
    const hiddenVisit = await p.addVisit(u.id, hidden.id);
    const post = (body: unknown) => t.call('/reviews', { token: u.token, body });
    const ok = { museum_id: m.id, visit_id: u.visitId, rating: 3 };

    let r = await post({ ...ok, museum_id: '00000000-0000-4000-8000-000000000001' });
    expect([r.status, await r.json()]).toEqual([422, { error: 'invalid', fields: ['museum_id'] }]);
    r = await post({ ...ok, museum_id: hidden.id, visit_id: hiddenVisit });
    expect([r.status, await r.json()]).toEqual([422, { error: 'invalid', fields: ['museum_id'] }]);
    // A visit that does not exist, one to another museum, and another member's visit.
    const elsewhere = await p.addVisit(u.id, (await fresh()).id);
    const stranger = await memberWithVisit(p, t, m.id);
    for (const visit_id of ['00000000-0000-4000-8000-000000000002', elsewhere, stranger.visitId]) {
      r = await post({ ...ok, visit_id });
      expect([r.status, await r.json()], visit_id).toEqual([422, { error: 'invalid', fields: ['visit_id'] }]);
    }
    for (const bad of [
      { rating: 0 },
      { rating: 6 },
      { rating: 3.5 },
      { collection: 9 },
      { user_id: u.id },
      { state: 'removed' },
    ]) {
      r = await post({ ...ok, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post({})).status).toBe(400);
    expect(await count('SELECT count(*) AS n FROM review WHERE user_id = $1', [u.id])).toBe(0);
  });

  it('a second review of the same museum is a 409, even citing another visit', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id, { on: '2026-01-01' });
    const second = await p.addVisit(u.id, m.id, { on: '2026-02-02' });
    expect(
      (await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 5 } })).status,
    ).toBe(201);
    for (const visit_id of [u.visitId, second]) {
      const r = await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id, rating: 1 } });
      expect([r.status, await r.json()]).toEqual([409, { error: 'conflict' }]);
    }
    expect(await count('SELECT count(*) AS n FROM review WHERE user_id = $1', [u.id])).toBe(1);
  });

  it('a closed museum is a 409 on POST and on PATCH, and DELETE is still 204', async () => {
    const closed = await closedMuseum(p);
    const u = await memberWithVisit(p, t, closed.id);
    const post = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: closed.id, visit_id: u.visitId, rating: 4 },
    });
    expect([post.status, await post.json()]).toEqual([409, { error: 'conflict' }]);
    expect(await count('SELECT count(*) AS n FROM review WHERE user_id = $1', [u.id])).toBe(0);
    // A review that predates the closing (inserted directly, as the owner would after a sync): read-only, deletable.
    const id = await addReview(p, { userId: u.id, museumId: closed.id, visitId: u.visitId, rating: 4 });
    const patch = await t.call(`/reviews/${id}`, { method: 'PATCH', token: u.token, body: { rating: 1 } });
    expect([patch.status, await patch.json()]).toEqual([409, { error: 'conflict' }]);
    expect((await p.admin.query('SELECT rating FROM review WHERE id = $1', [id])).rows[0]?.rating).toBe(4);
    expect((await t.call(`/reviews/${id}`, { method: 'DELETE', token: u.token })).status).toBe(204);
  });

  it('a museum that closes in the future is still open for reviews', async () => {
    const r = await p.owner.query<{ id: string }>(
      `SELECT id FROM museum WHERE NOT hidden AND closed_on = '2027-03-31'`,
    );
    const id = r.rows[0]?.id as string;
    const u = await memberWithVisit(p, t, id);
    expect(
      (await t.call('/reviews', { token: u.token, body: { museum_id: id, visit_id: u.visitId, rating: 3 } })).status,
    ).toBe(201);
  });

  it('writes one content_ip_log row with the review as target and the client address, queues the stats once', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    t.state.peer = '198.51.100.55';
    await p.admin.query("DELETE FROM job WHERE kind = 'stats_recompute'");
    const r = await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 4 } });
    const { id } = OwnReview.parse(await r.json());
    const log = await p.admin.query(
      'SELECT user_id, target_kind, host(ip) AS ip FROM content_ip_log WHERE target_id = $1',
      [id],
    );
    expect(log.rows).toEqual([{ user_id: u.id, target_kind: 'review', ip: '198.51.100.55' }]);
    expect(await count("SELECT count(*) AS n FROM job WHERE kind = 'stats_recompute' AND state = 'queued'")).toBe(1);
    t.state.peer = '203.0.113.7';
  });

  it('an unknown client address is a 429 before anything is written', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    t.state.peer = undefined;
    const r = await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 4 } });
    t.state.peer = '203.0.113.7';
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await count('SELECT count(*) AS n FROM review WHERE user_id = $1', [u.id])).toBe(0);
  });

  it('a refused write counts for nothing: validation, ownership and conflict failures leave the bucket alone', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    for (let i = 0; i < 25; i++) {
      expect(
        (await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 9 } }))
          .status,
      ).toBe(400);
      expect(
        (await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: m.id, rating: 3 } })).status,
      ).toBe(422);
    }
    expect(
      (await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 3 } })).status,
    ).toBe(201);
  });
});

describe('PATCH /reviews/:id', () => {
  const setup = async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id, { on: '2026-04-01' });
    const r = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 3, collection: 2, body: 'Eerste tekst' },
    });
    const own = OwnReview.parse(await r.json());
    return { m, u, id: own.id, own };
  };
  const patch = (u: { token: string }, id: string, body: unknown) =>
    t.call(`/reviews/${id}`, { method: 'PATCH', token: u.token, body });
  const revisions = (id: string) =>
    p.admin.query('SELECT rating, collection, body FROM review_revision WHERE review_id = $1 ORDER BY id', [id]);

  it('a change of rating, an aspect or the body writes one revision with the previous values and sets edited_at', async () => {
    const { u, id } = await setup();
    const r = await patch(u, id, { rating: 5, body: 'Tweede tekst' });
    expect(r.status).toBe(200);
    const own = OwnReview.parse(await r.json());
    expect(own).toMatchObject({ rating: 5, body: 'Tweede tekst', collection: 2 });
    expect(own.edited_at).not.toBeNull();
    expect((await revisions(id)).rows).toEqual([{ rating: 3, collection: 2, body: 'Eerste tekst' }]);

    // An aspect cleared with null, then the body cleared: two more revisions, each holding what it replaced.
    expect(OwnReview.parse(await (await patch(u, id, { collection: null })).json()).collection).toBeNull();
    expect(OwnReview.parse(await (await patch(u, id, { body: null })).json()).body).toBeNull();
    expect((await revisions(id)).rows).toEqual([
      { rating: 3, collection: 2, body: 'Eerste tekst' },
      { rating: 5, collection: 2, body: 'Tweede tekst' },
      { rating: 5, collection: null, body: 'Tweede tekst' },
    ]);
  });

  it('a patch that changes nothing, or only the cited visit, writes no revision and leaves edited_at alone', async () => {
    const { m, u, id } = await setup();
    const other = await p.addVisit(u.id, m.id, { on: '2026-04-02' });
    let r = await patch(u, id, { rating: 3, body: 'Eerste tekst', collection: 2 });
    expect(r.status).toBe(200);
    expect(OwnReview.parse(await r.json()).edited_at).toBeNull();
    r = await patch(u, id, { visit_id: other });
    expect(r.status).toBe(200);
    expect(OwnReview.parse(await r.json())).toMatchObject({
      visit_id: other,
      visited_on: '2026-04-02',
      edited_at: null,
    });
    expect((await revisions(id)).rowCount).toBe(0);
  });

  it('a new visit_id must be the member’s own visit to that museum (422 visit_id); the review is untouched', async () => {
    const { m, u, id } = await setup();
    const elsewhere = await p.addVisit(u.id, (await fresh()).id);
    const stranger = await memberWithVisit(p, t, m.id);
    for (const visit_id of [elsewhere, stranger.visitId, '00000000-0000-4000-8000-000000000003']) {
      const r = await patch(u, id, { visit_id, rating: 1 });
      expect([r.status, await r.json()], visit_id).toEqual([422, { error: 'invalid', fields: ['visit_id'] }]);
    }
    const row = (await p.admin.query('SELECT rating, visit_id FROM review WHERE id = $1', [id])).rows[0];
    expect(row?.rating).toBe(3);
    expect((await revisions(id)).rowCount).toBe(0);
  });

  it('another member’s review, a removed one, one of a hidden museum and an unknown id are all 404', async () => {
    const { u, id, m } = await setup();
    const stranger = await memberWithVisit(p, t, m.id);
    expect((await patch(stranger, id, { rating: 1 })).status).toBe(404);
    expect((await patch(u, '00000000-0000-4000-8000-000000000004', { rating: 1 })).status).toBe(404);
    await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [m.id]);
    expect((await patch(u, id, { rating: 1 })).status).toBe(404);
    await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [m.id]);
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [id]);
    expect((await patch(u, id, { rating: 1 })).status).toBe(404);
    expect((await revisions(id)).rowCount).toBe(0);
  });

  it('refuses an empty patch and the fields a member may not set, with 400', async () => {
    const { u, id } = await setup();
    for (const body of [{}, { museum_id: u.id }, { user_id: u.id }, { state: 'removed' }, { rating: 7 }]) {
      expect((await patch(u, id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('writes one content_ip_log row per PATCH, with the review as target, even when nothing changed', async () => {
    const { u, id } = await setup();
    await patch(u, id, { rating: 4 });
    await patch(u, id, { rating: 4 });
    const rows = await p.admin.query('SELECT target_kind, user_id FROM content_ip_log WHERE target_id = $1', [id]);
    // The POST wrote one, each PATCH one.
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((r) => r.target_kind === 'review' && r.user_id === u.id)).toBe(true);
  });

  it('queues the stats recompute', async () => {
    const { u, id } = await setup();
    await p.admin.query("DELETE FROM job WHERE kind = 'stats_recompute'");
    await patch(u, id, { rating: 1 });
    expect(await count("SELECT count(*) AS n FROM job WHERE kind = 'stats_recompute' AND state = 'queued'")).toBe(1);
  });
});

describe('DELETE /reviews/:id', () => {
  it('deletes the review and its revisions, frees the museum for a new review and queues the stats', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    const made = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 2 },
    });
    const { id } = OwnReview.parse(await made.json());
    await t.call(`/reviews/${id}`, { method: 'PATCH', token: u.token, body: { rating: 4 } });
    await p.admin.query("DELETE FROM job WHERE kind = 'stats_recompute'");
    expect((await t.call(`/reviews/${id}`, { method: 'DELETE', token: u.token })).status).toBe(204);
    expect(await count('SELECT count(*) AS n FROM review_revision WHERE review_id = $1', [id])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM job WHERE kind = 'stats_recompute' AND state = 'queued'")).toBe(1);
    expect(
      (await t.call('/reviews', { token: u.token, body: { museum_id: m.id, visit_id: u.visitId, rating: 5 } })).status,
    ).toBe(201);
  });
});

describe('the daily limit (20 writes, POST and PATCH)', () => {
  it('answers the 21st write with 429 and Retry-After, and a refused write leaves no row and no revision', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id);
    const made = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 1 },
    });
    const { id } = OwnReview.parse(await made.json());
    // 19 PATCHes, the 20th write in all (the rating moves each time so every one writes a revision).
    for (let i = 1; i <= 19; i++) {
      const r = await t.call(`/reviews/${id}`, { method: 'PATCH', token: u.token, body: { rating: (i % 5) + 1 } });
      expect(r.status, `write ${i + 1}`).toBe(200);
    }
    const before = await count('SELECT count(*) AS n FROM review_revision WHERE review_id = $1', [id]);
    const rating = (await p.admin.query('SELECT rating FROM review WHERE id = $1', [id])).rows[0]?.rating;
    const r = await t.call(`/reviews/${id}`, {
      method: 'PATCH',
      token: u.token,
      body: { rating: rating === 5 ? 1 : 5 },
    });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) AS n FROM review_revision WHERE review_id = $1', [id])).toBe(before);
    expect((await p.admin.query('SELECT rating FROM review WHERE id = $1', [id])).rows[0]?.rating).toBe(rating);
    // The refused PATCH wrote no content_ip_log row either (the POST and the 19 PATCHes did).
    expect(await count('SELECT count(*) AS n FROM content_ip_log WHERE target_id = $1', [id])).toBe(20);
    // A POST is refused the same way, and DELETE is not limited.
    const m2 = await fresh();
    const v2 = await p.addVisit(u.id, m2.id);
    const post = await t.call('/reviews', { token: u.token, body: { museum_id: m2.id, visit_id: v2, rating: 3 } });
    expect(post.status).toBe(429);
    expect(await count('SELECT count(*) AS n FROM review WHERE user_id = $1 AND museum_id = $2', [u.id, m2.id])).toBe(
      0,
    );
    expect((await t.call(`/reviews/${id}`, { method: 'DELETE', token: u.token })).status).toBe(204);
    // The bucket is per member: another member is not affected.
    const v = await memberWithVisit(p, t, m2.id);
    expect(
      (await t.call('/reviews', { token: v.token, body: { museum_id: m2.id, visit_id: v.visitId, rating: 3 } })).status,
    ).toBe(201);
  });
});

describe('the public reads', () => {
  const get = async (path: string, status = 200) => {
    const [a, s] = [await t.call(path), await t.ssrGet(path)];
    expect(a.status, path).toBe(status);
    expect(s.status, `ssr ${path}`).toBe(status);
    const text = await a.text();
    expect(await s.text(), `${path}: api and ssr differ`).toBe(text);
    return { r: a, text, body: text === '' ? null : JSON.parse(text) };
  };

  it('GET /reviews/:id: the public review, with the cited visit’s date, and nothing private', async () => {
    const m = await fresh();
    const x = await memberWithReview(p, m.id, { rating: 5, body: 'Prachtig', on: '2026-06-06' });
    const { r, body, text } = await get(`/reviews/${x.reviewId}`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    const review = PublicReview.parse(body);
    expect(review).toMatchObject({
      id: x.reviewId,
      museum: { id: m.id, slug: m.slug },
      author: { handle: x.handle, active: true, former_member: false },
      visited_on: '2026-06-06',
      rating: 5,
      body: 'Prachtig',
      edited_at: null,
    });
    for (const secret of [x.userId, x.visitId, 'user_id', 'visit_id', 'state']) expect(text).not.toContain(secret);
  });

  it('GET /reviews/:id: a bad uuid, an unknown id, a removed review, a hidden museum and a deleted author are all 404', async () => {
    const m = await fresh();
    const removed = await memberWithReview(p, m.id);
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [removed.reviewId]);
    const hidden = await p.hidden();
    const inHidden = await memberWithReview(p, hidden.id);
    const gone = await memberWithReview(p, m.id, { status: 'deleted' });
    for (const id of [
      'nope',
      '123',
      '00000000-0000-4000-8000-000000000005',
      removed.reviewId,
      inHidden.reviewId,
      gone.reviewId,
    ]) {
      const { body } = await get(`/reviews/${id}`, 404);
      expect(body).toEqual({ error: 'not_found' });
    }
  });

  it('GET /museums/:slug/reviews: newest first, paged without overlap, next_cursor null on the last page', async () => {
    const m = await fresh();
    for (let i = 0; i < 5; i++) await memberWithReview(p, m.id, { rating: (i % 5) + 1, body: `Review ${i}` });
    const expected = (
      await p.admin.query<{ id: string }>('SELECT id FROM review WHERE museum_id = $1 ORDER BY id DESC', [m.id])
    ).rows.map((r) => r.id);
    expect(expected).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const q: string = `limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const { body } = await get(`/museums/${m.slug}/reviews?${q}`);
      const list = ReviewList.parse(body);
      expect(list.items.length).toBe(page < 2 ? 2 : 1);
      seen.push(...list.items.map((i) => i.id));
      cursor = list.next_cursor;
      expect(cursor === null).toBe(page === 2);
    }
    expect(seen).toEqual(expected);
    // The default page holds all five and has no next.
    const all = ReviewList.parse((await get(`/museums/${m.slug}/reviews`)).body);
    expect(all.items.map((i) => i.id)).toEqual(expected);
    expect(all.next_cursor).toBeNull();
  });

  it('GET /museums/:slug/reviews: an old slug is a 301 to the current one, unknown and hidden museums 404, bad queries 400', async () => {
    const { renamed, hiddenWithOldSlug } = p.catalogue.named;
    const moved = await t.call(`/museums/${renamed.oldSlugs[0]}/reviews`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe(`/api/v1/museums/${renamed.slug}/reviews`);
    expect(moved.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    expect(ReviewList.parse((await get(`/museums/${renamed.slug}/reviews`)).body).items).toBeDefined();

    const hidden = await p.hidden();
    await memberWithReview(p, hidden.id);
    await get(`/museums/${hidden.slug}/reviews`, 404);
    await get('/museums/no-such-museum-here/reviews', 404);
    expect((await t.call(`/museums/${hiddenWithOldSlug.oldSlug}/reviews`)).status).toBe(404);

    const m = await fresh();
    const base = `/museums/${m.slug}/reviews`;
    for (const q of [
      '?limit=0',
      '?limit=51',
      '?limit=x',
      '?sort=rank',
      '?limit=1&limit=2',
      '?cursor=%%%',
      '?cursor=abc',
    ]) {
      expect((await t.call(base + q)).status, q).toBe(400);
    }
    // A cursor of another mode is refused with its field named.
    const nameCursor = Buffer.from(JSON.stringify({ m: 'n', k: 'a', i: m.id })).toString('base64url');
    const r = await t.call(`${base}?cursor=${nameCursor}`);
    expect([r.status, await r.json()]).toEqual([400, { error: 'bad_request', fields: ['cursor'] }]);
  });

  it('a banned author’s review stays without a handle; a deleted author’s and a removed review are absent; a hidden museum has none', async () => {
    const m = await fresh();
    const good = await memberWithReview(p, m.id, { body: 'Goed' });
    const banned = await memberWithReview(p, m.id, { status: 'banned', body: 'Verbannen' });
    const gone = await memberWithReview(p, m.id, { status: 'deleted', body: 'Verwijderd' });
    const removed = await memberWithReview(p, m.id, { body: 'Weggehaald' });
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [removed.reviewId]);

    const list = ReviewList.parse((await get(`/museums/${m.slug}/reviews`)).body);
    expect(list.items.map((i) => i.id).sort()).toEqual([good.reviewId, banned.reviewId].sort());
    const b = list.items.find((i) => i.id === banned.reviewId);
    expect(b?.author).toMatchObject({ handle: null, active: false, former_member: false });
    expect(list.items.find((i) => i.id === good.reviewId)?.author).toMatchObject({ handle: good.handle, active: true });
    // The banned author's single review is still readable by id, handle-less; the deleted author's is not.
    expect(PublicReview.parse((await get(`/reviews/${banned.reviewId}`)).body).author.handle).toBeNull();
    await get(`/reviews/${gone.reviewId}`, 404);

    // The author's own profile route: banned and deleted members are a 404, an active one lists the review.
    await get(`/users/${banned.handle}/reviews`, 404);
    await get(`/users/${gone.handle}/reviews`, 404);
    const mine = ReviewList.parse((await get(`/users/${good.handle}/reviews`)).body);
    expect(mine.items.map((i) => i.id)).toEqual([good.reviewId]);

    // The museum turns hidden: its reviews vanish from the museum route (404), the user route and by id.
    await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [m.id]);
    await get(`/museums/${m.slug}/reviews`, 404);
    await get(`/reviews/${good.reviewId}`, 404);
    expect(ReviewList.parse((await get(`/users/${good.handle}/reviews`)).body).items).toEqual([]);
    await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [m.id]);
  });

  it('GET /users/:handle/reviews: newest first across museums, paged; a bad handle and an unknown member are the same 404', async () => {
    const u = await p.newMember({ handle: 'reviewer_ten' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await fresh();
      const visitId = await p.addVisit(u.id, m.id);
      ids.push(await addReview(p, { userId: u.id, museumId: m.id, visitId, rating: 3, body: `Nr ${i}` }));
    }
    const first = ReviewList.parse((await get('/users/reviewer_ten/reviews?limit=2')).body);
    expect(first.items).toHaveLength(2);
    const second = ReviewList.parse(
      (await get(`/users/reviewer_ten/reviews?limit=2&cursor=${first.next_cursor}`)).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect([...first.items, ...second.items].map((i) => i.id)).toEqual([...ids].sort().reverse());
    // The profile shows reviews whatever the visit and wishlist settings are (private by default).
    for (const handle of ['X', 'ab', 'nobody_here', '..%2f', 'a'.repeat(60)]) {
      expect((await get(`/users/${handle}/reviews`, 404)).body).toEqual({ error: 'not_found' });
    }
    expect((await t.call('/users/reviewer_ten/reviews?cursor=zzz')).status).toBe(400);
  });
});

describe('GET /me/museums/:slug and /me/marks', () => {
  it('review is the member’s own visible review of that museum, else null; marks carry the member’s setting', async () => {
    const m = await fresh();
    const u = await memberWithVisit(p, t, m.id, { on: '2026-05-05' });
    const view = async () => {
      const r = await t.call(`/me/museums/${m.slug}`, { token: u.token });
      expect(r.status).toBe(200);
      return ((await r.json()) as { review: unknown }).review;
    };
    expect(await view()).toBeNull();
    const made = await t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 4, body: 'Ja' },
    });
    const own = OwnReview.parse(await made.json());
    expect(OwnReview.parse(await view())).toEqual(own);
    // Another member sees null; a removed review is no longer the member's own.
    const other = await memberWithVisit(p, t, m.id);
    expect(
      ((await (await t.call(`/me/museums/${m.slug}`, { token: other.token })).json()) as { review: unknown }).review,
    ).toBeNull();
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [own.id]);
    expect(await view()).toBeNull();

    const marks = async (token: string) =>
      ((await (await t.call('/me/marks', { token })).json()) as { marks: { hide_ratings_until_visited: boolean } })
        .marks;
    expect((await marks(u.token)).hide_ratings_until_visited).toBe(false);
    await p.owner.query(
      `UPDATE app_user SET settings = settings || '{"hide_ratings_until_visited": true}' WHERE id = $1`,
      [u.id],
    );
    expect((await marks(u.token)).hide_ratings_until_visited).toBe(true);
    expect((await marks(other.token)).hide_ratings_until_visited).toBe(false);
  });
});
