import { ErrorBody, MemberMuseum, MuseumList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeMuseums } from '../../src/api/routes/me-museums.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// GET /me/museums and /me/museums/:slug (A§10, A§14): the catalogue list narrowed to the member's visits and
// wishlist, in the browse and the search branch, with the cursor rules of the public list; and one museum's
// own visits and wishlist flag.

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const setup = () => {
  const t = meApp(p, mountMeMuseums);
  return { ...t, as: async (userId: string) => ({ token: await t.signIn(userId) }) };
};

/** Every page of a query, in order. */
async function pages(call: ReturnType<typeof setup>['call'], token: string, query: string, limit: number) {
  const items: MuseumList['items'] = [];
  let total = -1;
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    const r = await call(`/me/museums?${query}&limit=${limit}${cursor === undefined ? '' : `&cursor=${cursor}`}`, {
      token,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = MuseumList.parse(await r.json());
    items.push(...body.items);
    total = body.total;
    if (body.next_cursor === null) return { items, total };
    cursor = body.next_cursor;
  }
  throw new Error('paging did not end');
}

describe('GET /me/museums', () => {
  it('signed out is 401', async () => {
    const { call } = setup();
    const r = await call('/me/museums?visited=yes');
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await call('/me/museums/x')).status).toBe(401);
  });

  it('visited=yes, wishlist=yes and visited=no narrow the browse list; total follows; paging is stable', async () => {
    const { call, signIn } = setup();
    const u = await p.newMember();
    const token = await signIn(u.id);
    const seen = [
      await p.visible(70),
      await p.visible(71),
      await p.visible(72),
      await p.visible(73),
      await p.visible(74),
    ];
    for (const m of seen) await p.addVisit(u.id, m.id);
    await p.addVisit(u.id, seen[0]?.id as string, { on: '2026-06-06' }); // two visits, still one museum
    const wished = [await p.visible(75), seen[1] as { id: string }];
    for (const m of wished) await p.addWishlist(u.id, m.id);
    await p.addVisit(u.id, (await p.hidden()).id);

    const yes = await pages(call, token, 'visited=yes', 2);
    expect(yes.items.map((i) => i.id).sort()).toEqual(seen.map((m) => m.id).sort());
    expect(yes.total).toBe(5);
    expect(new Set(yes.items.map((i) => i.id)).size).toBe(5);

    const wish = await pages(call, token, 'wishlist=yes', 50);
    expect(wish.items.map((i) => i.id).sort()).toEqual(wished.map((m) => m.id).sort());
    expect((await pages(call, token, 'visited=yes&wishlist=yes', 50)).items.map((i) => i.id)).toEqual([seen[1]?.id]);

    const no = await pages(call, token, 'visited=no', 50);
    const all = MuseumList.parse(await (await call('/me/museums?limit=1', { token })).json()).total;
    expect(no.total).toBe(all - 5);
    expect(no.items.length).toBe(no.total);
    expect(new Set(no.items.map((i) => i.id)).size).toBe(no.total);
    expect(no.items.some((i) => seen.some((m) => m.id === i.id))).toBe(false);
  });

  it('the filters work in the search branch too (with q), and a stranger sees none of them', async () => {
    const { call, signIn } = setup();
    const u = await p.newMember();
    const other = await p.newMember();
    const token = await signIn(u.id);
    const m = await p.visible(80);
    const name = MuseumList.parse(
      await (await call(`/me/museums?q=${encodeURIComponent(await nameOf(m.id))}`, { token })).json(),
    );
    expect(name.items.map((i) => i.id)).toContain(m.id);
    await p.addVisit(u.id, m.id);
    const q = encodeURIComponent(await nameOf(m.id));
    const yes = await pages(call, token, `q=${q}&visited=yes`, 1);
    expect(yes.items.map((i) => i.id)).toEqual([m.id]);
    expect(yes.total).toBe(1);
    const no = await pages(call, token, `q=${q}&visited=no`, 2);
    expect(no.items.map((i) => i.id)).not.toContain(m.id);
    expect(no.total).toBe(name.total - 1);
    expect(new Set(no.items.map((i) => i.id)).size).toBe(no.items.length);
    // The other member has not visited it.
    const theirs = await pages(call, await signIn(other.id), `q=${q}&visited=yes`, 5);
    expect(theirs.items).toEqual([]);
    expect(theirs.total).toBe(0);
  });

  it('keeps the public list rules: a bad value, a repeat or a foreign cursor is 400; a hidden museum is never listed', async () => {
    const { call, signIn } = setup();
    const u = await p.newMember();
    const token = await signIn(u.id);
    const hidden = await p.hidden();
    await p.addVisit(u.id, hidden.id);
    await p.addWishlist(u.id, hidden.id);
    for (const q of ['visited=maybe', 'visited=yes&visited=no', 'wishlist=1', 'cursor=@@@', 'nope=1']) {
      expect((await call(`/me/museums?${q}`, { token })).status, q).toBe(400);
    }
    // A name cursor is refused in search mode.
    const first = MuseumList.parse(await (await call('/me/museums?limit=1', { token })).json());
    const r = await call(`/me/museums?q=amsterdam&cursor=${first.next_cursor}`, { token });
    expect(r.status).toBe(400);
    expect(ErrorBody.parse(await r.json())).toEqual({ error: 'bad_request', fields: ['cursor'] });
    expect((await pages(call, token, 'visited=yes', 5)).items).toEqual([]);
    expect((await pages(call, token, 'wishlist=yes', 5)).total).toBe(0);
  });
});

async function nameOf(id: string): Promise<string> {
  return ((await p.owner.query('SELECT name FROM museum WHERE id = $1', [id])).rows[0] as { name: string }).name;
}

describe('GET /me/museums/:slug', () => {
  it("returns the member's visits, newest first, and the wishlist flag; only their own", async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const other = await p.newMember();
    const m = await p.visible(90);
    await p.addVisit(u.id, m.id, { on: '2025-05-05', note: 'a' });
    await p.addVisit(u.id, m.id, { on: '2026-01-01', note: 'b' });
    await p.addVisit(u.id, m.id, { on: null });
    await p.addVisit(other.id, m.id, { on: '2026-02-02', note: 'geheim' });
    const r = await call(`/me/museums/${m.slug}`, await as(u.id));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const got = MemberMuseum.parse(await r.json());
    expect(got.visits.map((v) => v.visited_on)).toEqual(['2026-01-01', '2025-05-05', null]);
    expect(got.visits.map((v) => v.note)).toEqual(['b', 'a', null]);
    expect(got.wishlist).toBe(false);
    await p.addWishlist(u.id, m.id);
    expect(MemberMuseum.parse(await (await call(`/me/museums/${m.slug}`, await as(u.id))).json()).wishlist).toBe(true);
    const theirs = MemberMuseum.parse(await (await call(`/me/museums/${m.slug}`, await as(other.id))).json());
    expect(theirs.visits).toHaveLength(1);
    const empty = MemberMuseum.parse(
      await (await call(`/me/museums/${m.slug}`, await as((await p.newMember()).id))).json(),
    );
    expect(empty).toEqual({ visits: [], wishlist: false, review: null });
  });

  it('an unknown or hidden museum is 404, an invalid slug 400', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const hidden = await p.hidden();
    expect((await call('/me/museums/no-such-museum', t)).status).toBe(404);
    expect((await call(`/me/museums/${hidden.slug}`, t)).status).toBe(404);
    expect((await call('/me/museums/Not%20A%20Slug', t)).status).toBe(400);
  });
});
