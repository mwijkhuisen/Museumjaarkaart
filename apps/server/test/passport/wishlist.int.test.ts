import { Marks, Wishlist } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeWishlist } from '../../src/api/routes/me-wishlist.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// /me/wishlist and /me/marks (A§10): idempotent PUT and DELETE, newest first, hidden museums named without
// a link, and marks that are null when signed out and count visible museums only.

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const setup = () => {
  const t = meApp(p, mountMeWishlist);
  return { ...t, as: async (userId: string) => ({ token: await t.signIn(userId) }) };
};

describe('signed out', () => {
  it('the wishlist routes are 401; marks is 200 {"marks":null}; all private and uncacheable', async () => {
    const { call } = setup();
    const id = '0198a5a0-0000-7000-8000-000000000000';
    for (const [method, path] of [
      ['GET', '/me/wishlist'],
      ['PUT', `/me/wishlist/${id}`],
      ['DELETE', `/me/wishlist/${id}`],
    ] as const) {
      const r = await call(path, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
    const r = await call('/me/marks');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.text()).toBe('{"marks":null}');
  });
});

describe('wishlist', () => {
  it('PUT is 204 and idempotent; GET lists newest first; DELETE is 204 and idempotent', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const [a, b] = [await p.visible(40), await p.visible(41)];
    for (const m of [a, b, a]) {
      const r = await call(`/me/wishlist/${m.id}`, { method: 'PUT', ...t });
      expect(r.status).toBe(204);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
    // Backdate b's row so the order does not depend on the clock.
    await p.owner.query(
      "UPDATE wishlist SET created_at = now() + interval '1 hour' WHERE user_id = $1 AND museum_id = $2",
      [u.id, b.id],
    );
    const r = await call('/me/wishlist', t);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const list = Wishlist.parse(await r.json());
    expect(list.items.map((i) => i.museum.id)).toEqual([b.id, a.id]);
    expect(list.items[0]?.museum.slug).toBe(b.slug);
    for (const _ of [0, 1]) expect((await call(`/me/wishlist/${a.id}`, { method: 'DELETE', ...t })).status).toBe(204);
    expect(Wishlist.parse(await (await call('/me/wishlist', t)).json()).items.map((i) => i.museum.id)).toEqual([b.id]);
  });

  it("is the member's own: another member's wishlist is untouched and unseen", async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const other = await p.newMember();
    const m = await p.visible(42);
    await p.addWishlist(u.id, m.id);
    expect(Wishlist.parse(await (await call('/me/wishlist', await as(other.id))).json()).items).toEqual([]);
    await call(`/me/wishlist/${m.id}`, { method: 'DELETE', ...(await as(other.id)) });
    expect((await p.owner.query('SELECT 1 FROM wishlist WHERE user_id = $1', [u.id])).rowCount).toBe(1);
  });

  it('PUT of an unknown or hidden museum is 404; a bad id is 400; nothing is stored', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const hidden = await p.hidden();
    for (const id of [hidden.id, '0198a5a0-0000-7000-8000-000000000001']) {
      expect((await call(`/me/wishlist/${id}`, { method: 'PUT', ...t })).status).toBe(404);
    }
    expect((await call('/me/wishlist/nope', { method: 'PUT', ...t })).status).toBe(400);
    expect((await call('/me/wishlist/nope', { method: 'DELETE', ...t })).status).toBe(400);
    expect((await p.owner.query('SELECT 1 FROM wishlist WHERE user_id = $1', [u.id])).rowCount).toBe(0);
  });

  it('a museum hidden after it was wishlisted is still named, with slug null', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const m = await p.visible(61);
    await p.addWishlist(u.id, m.id);
    await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [m.id]);
    try {
      const list = Wishlist.parse(await (await call('/me/wishlist', await as(u.id))).json());
      expect(list.items[0]?.museum).toMatchObject({ id: m.id, slug: null });
    } finally {
      await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [m.id]);
    }
  });
});

describe('GET /me/marks', () => {
  it('lists the distinct visible museums visited and wishlisted; hidden ones are left out', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const [a, b, c] = [await p.visible(50), await p.visible(51), await p.visible(52)];
    const hidden = await p.hidden();
    await p.addVisit(u.id, a.id, { on: '2026-01-01' });
    await p.addVisit(u.id, a.id, { on: '2026-02-01' }); // a second visit to a: still one mark
    await p.addVisit(u.id, hidden.id, { on: null });
    await p.addWishlist(u.id, b.id);
    await p.addWishlist(u.id, c.id);
    await p.addWishlist(u.id, hidden.id);
    const r = await call('/me/marks', await as(u.id));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const marks = Marks.parse(await r.json()).marks;
    expect(marks?.visited).toEqual([a.id]);
    expect(marks?.wishlist).toEqual([b.id, c.id].sort());
  });

  it('a new member has empty marks; an unknown parameter is 400', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    expect(Marks.parse(await (await call('/me/marks', t)).json())).toEqual({ marks: { visited: [], wishlist: [] } });
    expect((await call('/me/marks?x=1', t)).status).toBe(400);
  });
});
