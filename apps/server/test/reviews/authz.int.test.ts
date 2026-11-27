import { OwnReview } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { banUser } from '../../src/auth/ban.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { memberWithVisit, openMuseum, reviewsApp } from './app.ts';
import { addReview } from './fixtures.ts';

// A§18: every route has an authorization table test. The review writes: anonymous, a session of the other host
// class, a member, another member (a 404, never a 403), a banned member's session (a 401: the session loader
// drops it) and a member who has not accepted the current terms (403 `terms_required` on POST and PATCH; DELETE
// is allowed). The public reads answer the same with and without a cookie.

let p: PassportDb;
let t: ReturnType<typeof reviewsApp>;
beforeAll(async () => {
  p = await openPassportDb();
  t = reviewsApp(p);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const OLD_TERMS = '2020-01-01';
let nth = 0;

/** A member with a visit to a fresh museum and a review of it, and a second member with a visit to that museum. */
async function scene() {
  const museum = await openMuseum(p, 100 + nth++);
  const me = await memberWithVisit(p, t, museum.id);
  const other = await memberWithVisit(p, t, museum.id);
  const reviewId = await addReview(p, { userId: me.id, museumId: museum.id, visitId: me.visitId, rating: 3 });
  return { museum, me, other, reviewId };
}

const create = (s: Awaited<ReturnType<typeof scene>>, who: { visitId: string }) => ({
  museum_id: s.museum.id,
  visit_id: who.visitId,
  rating: 4,
});

describe('POST /reviews', () => {
  it('anonymous 401, other host 401, member 201, banned 401, terms not accepted 403', async () => {
    const museum = await openMuseum(p, 200);
    const mk = async () => memberWithVisit(p, t, museum.id);
    const body = (m: { visitId: string }) => ({ museum_id: museum.id, visit_id: m.visitId, rating: 5 });

    const anon = await mk();
    const r401 = await t.call('/reviews', { body: body(anon) });
    expect(r401.status).toBe(401);
    expect(await r401.json()).toEqual({ error: 'unauthorized' });

    const adm = await t.signIn(anon.id, 'admin');
    expect((await t.call('/reviews', { token: adm, body: body(anon) })).status).toBe(401);

    const ok = await mk();
    const r201 = await t.call('/reviews', { token: ok.token, body: body(ok) });
    expect(r201.status).toBe(201);
    expect(r201.headers.get('cache-control')).toBe('private, no-store');

    const banned = await mk();
    await p.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [banned.id]);
    expect((await t.call('/reviews', { token: banned.token, body: body(banned) })).status).toBe(401);
    const viaBan = await mk();
    expect(
      await banUser(p.db, { userId: viaBan.id, until: null, reason: 'test', actorId: null, actorKind: 'system' }),
    ).toBe(true);
    expect((await t.call('/reviews', { token: viaBan.token, body: body(viaBan) })).status).toBe(401);

    const terms = await mk();
    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [terms.id, OLD_TERMS]);
    const r403 = await t.call('/reviews', { token: terms.token, body: body(terms) });
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: 'terms_required' });
    expect((await p.admin.query('SELECT 1 FROM review WHERE user_id = $1', [terms.id])).rowCount).toBe(0);
  });

  it("another member's visit is a 422 on visit_id, never a review of theirs", async () => {
    const s = await scene();
    const r = await t.call('/reviews', { token: s.other.token, body: create(s, s.me) });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['visit_id'] });
    expect((await p.admin.query('SELECT 1 FROM review WHERE user_id = $1', [s.other.id])).rowCount).toBe(0);
  });
});

describe('PATCH /reviews/:id', () => {
  it('anonymous 401, other host 401, member 200, another member 404, banned 401, terms not accepted 403', async () => {
    const s = await scene();
    const path = `/reviews/${s.reviewId}`;
    const patch = { rating: 5 };

    const r401 = await t.call(path, { method: 'PATCH', body: patch });
    expect(r401.status).toBe(401);
    expect(await r401.json()).toEqual({ error: 'unauthorized' });
    const adm = await t.signIn(s.me.id, 'admin');
    expect((await t.call(path, { method: 'PATCH', token: adm, body: patch })).status).toBe(401);

    // Another member: a 404 whatever the body, and the review is untouched.
    const r404 = await t.call(path, { method: 'PATCH', token: s.other.token, body: patch });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not_found' });
    expect((await p.admin.query('SELECT rating FROM review WHERE id = $1', [s.reviewId])).rows[0]?.rating).toBe(3);

    const r200 = await t.call(path, { method: 'PATCH', token: s.me.token, body: patch });
    expect(r200.status).toBe(200);
    expect(OwnReview.parse(await r200.json()).rating).toBe(5);

    // Terms: the member's own review, but not on the current terms.
    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [s.me.id, OLD_TERMS]);
    const r403 = await t.call(path, { method: 'PATCH', token: s.me.token, body: { rating: 1 } });
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: 'terms_required' });
    expect((await p.admin.query('SELECT rating FROM review WHERE id = $1', [s.reviewId])).rows[0]?.rating).toBe(5);

    await p.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [s.me.id]);
    expect((await t.call(path, { method: 'PATCH', token: s.me.token, body: patch })).status).toBe(401);
  });

  it('a malformed id is a 404 before any SQL, for a member', async () => {
    const s = await scene();
    for (const id of ['not-a-uuid', '1', `${s.reviewId}x`]) {
      const r = await t.call(`/reviews/${id}`, { method: 'PATCH', token: s.me.token, body: { rating: 2 } });
      expect(r.status, id).toBe(404);
    }
  });
});

describe('DELETE /reviews/:id', () => {
  it('anonymous 401, other host 401, another member 404, member 204, banned 401', async () => {
    const s = await scene();
    const path = `/reviews/${s.reviewId}`;
    expect((await t.call(path, { method: 'DELETE' })).status).toBe(401);
    const adm = await t.signIn(s.me.id, 'admin');
    expect((await t.call(path, { method: 'DELETE', token: adm })).status).toBe(401);

    const r404 = await t.call(path, { method: 'DELETE', token: s.other.token });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not_found' });
    expect((await p.admin.query('SELECT 1 FROM review WHERE id = $1', [s.reviewId])).rowCount).toBe(1);

    const banned = await scene();
    await p.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [banned.me.id]);
    expect((await t.call(`/reviews/${banned.reviewId}`, { method: 'DELETE', token: banned.me.token })).status).toBe(
      401,
    );

    const r204 = await t.call(path, { method: 'DELETE', token: s.me.token });
    expect(r204.status).toBe(204);
    expect(r204.headers.get('cache-control')).toBe('private, no-store');
    expect((await p.admin.query('SELECT 1 FROM review WHERE id = $1', [s.reviewId])).rowCount).toBe(0);
    // The same call again: nothing left, a 404 (not a 204).
    expect((await t.call(path, { method: 'DELETE', token: s.me.token })).status).toBe(404);
  });

  it('is allowed without the current terms', async () => {
    const s = await scene();
    await p.admin.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [s.me.id, OLD_TERMS]);
    expect((await t.call(`/reviews/${s.reviewId}`, { method: 'DELETE', token: s.me.token })).status).toBe(204);
  });

  it("a removed review is not the member's to delete: 404", async () => {
    const s = await scene();
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [s.reviewId]);
    expect((await t.call(`/reviews/${s.reviewId}`, { method: 'DELETE', token: s.me.token })).status).toBe(404);
    expect((await p.admin.query('SELECT 1 FROM review WHERE id = $1', [s.reviewId])).rowCount).toBe(1);
  });
});

describe('the public review reads', () => {
  it('answer the same without a cookie and with one (a good, a stale and a banned member), as api and as ssr', async () => {
    const s = await scene();
    const banned = await memberWithVisit(p, t, s.museum.id);
    await p.admin.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [banned.id]);
    const handle = s.me.handle;
    const paths = [`/reviews/${s.reviewId}`, `/museums/${s.museum.slug}/reviews`, `/users/${handle}/reviews`];
    for (const path of paths) {
      const anon = await t.call(path);
      expect(anon.status, path).toBe(200);
      expect(anon.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
      const bytes = await anon.text();
      for (const token of [s.me.token, s.other.token, banned.token, 'x'.repeat(43)]) {
        const r = await t.call(path, { token });
        expect(r.status, path).toBe(200);
        expect(await r.text(), path).toBe(bytes);
      }
      const viaSsr = await t.ssrGet(path);
      expect(viaSsr.status, path).toBe(200);
      expect(await viaSsr.text(), path).toBe(bytes);
    }
  });

  it('are GET-only: an unsafe method on a read path is not the read', async () => {
    const s = await scene();
    // POST /reviews/:id and PUT have no route: a 404 for a member, a 401 on the session paths for anonymous.
    expect((await t.call(`/reviews/${s.reviewId}`, { method: 'POST', token: s.me.token, body: {} })).status).toBe(404);
    expect((await t.call(`/reviews/${s.reviewId}`, { method: 'PUT', token: s.me.token, body: {} })).status).toBe(404);
  });
});
