import { PublicVisitList, PublicWishlist, UserProfile } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.ts';
import { mountUsers } from '../../src/api/routes/users.ts';
import { createDb } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';

// P2c WP8a (criteria 6, 7): the public profile routes as mjk_ssr, over the seeded catalogue. They read only
// the pub_* views and the two functions, so a private, banned, deleted or unknown member is one and the same 404.

let p: PassportDb;
let app: ReturnType<typeof buildApp>;
const get = (path: string) => app.request(`http://localhost/api/v1${path}`);
const json = async (path: string) => {
  const r = await get(path);
  expect(r.status, path).toBe(200);
  expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  return { r, text: await r.clone().text(), body: await r.json() };
};
const PUBLIC = { visits_visibility: 'public', wishlist_visibility: 'public' };

beforeAll(async () => {
  p = await openPassportDb();
  app = buildApp({ db: createDb(p.pools.ssr), logger: silentLogger, ping: async () => true }, mountUsers);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

describe('a public member', () => {
  it('shows progress, visits by month and the wishlist, and nothing finer or private', async () => {
    const u = await p.newMember({ handle: 'open_one', settings: PUBLIC });
    const [a, b, c, d, w1, w2] = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => p.visible(n)));
    const listed = await p.listed();
    const hidden = await p.hidden();
    const v1 = await p.addVisit(u.id, (a as { id: string }).id, {
      on: '2026-11-15',
      note: 'geheime notitie',
      ageHours: 48,
    });
    await p.addVisit(u.id, (b as { id: string }).id, { on: '2026-10-03', ageHours: 25 });
    await p.addVisit(u.id, (c as { id: string }).id, { on: '2026-11-20', ageHours: 0 }); // under 24 h: absent
    await p.addVisit(u.id, (d as { id: string }).id, { on: null, ageHours: 48 });
    await p.addVisit(u.id, listed.id, { on: '2026-11-02', ageHours: 48 });
    await p.addVisit(u.id, hidden.id, { on: '2026-11-02', ageHours: 48 }); // hidden museum: absent
    await p.addWishlist(u.id, (w1 as { id: string }).id);
    await p.addWishlist(u.id, (w2 as { id: string }).id);
    await p.addWishlist(u.id, hidden.id);

    const { body, text } = await json('/users/open_one');
    const profile = UserProfile.parse(body);
    expect(profile).toMatchObject({ handle: 'open_one', display_name: 'Member', indexable: false });
    expect(profile.member_since).toMatch(/^\d{4}-\d{2}$/);
    expect(profile.progress).toMatchObject({ all_time: 4, list: { visited: 1, n: p.catalogue.list.n } });
    const months = profile.visits?.items.map((i) => i.visited_month);
    expect(months).toEqual(['2026-11', '2026-11', '2026-10', null]);
    expect(profile.visits?.next).toBeNull();
    expect(profile.wishlist?.items).toHaveLength(2);

    for (const bad of ['geheime notitie', 'note', 'email', u.email, u.id, v1, 'visited_on', 'created_at', '2026-11-15'])
      expect(text, bad).not.toContain(bad);
    // No uuid at all: not the member's, not a visit's, not a museum's.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain(`"${hidden.slug}"`);
  });

  it('pages the visits and the wishlist across two pages, stable and without overlap', async () => {
    const u = await p.newMember({ handle: 'paged_one', settings: PUBLIC });
    const ms = await Promise.all([10, 11, 12, 13, 14].map((n) => p.visible(n)));
    const months = ['2026-09-01', '2026-09-20', '2026-08-05', null, '2026-09-11'];
    for (const [i, m] of ms.entries()) {
      await p.addVisit(u.id, m.id, { on: months[i] ?? null, ageHours: 48 });
      await p.addWishlist(u.id, m.id);
    }
    for (const list of ['visits', 'wishlist'] as const) {
      const schema = list === 'visits' ? PublicVisitList : PublicWishlist;
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
        const { body } = await json(`/users/paged_one/${list}?${q}`);
        const page = schema.parse(body);
        seen.push(...page.items.map((i) => i.museum.slug));
        cursor = page.next;
        pages += 1;
      } while (cursor !== null && pages < 5);
      expect(pages, list).toBe(3);
      expect(seen, list).toHaveLength(5);
      expect(new Set(seen).size, list).toBe(5);
      expect(new Set(seen), list).toEqual(new Set(ms.map((m) => m.slug)));
      // Paging does not change the order: the pages joined are the whole list.
      const whole = schema.parse((await json(`/users/paged_one/${list}`)).body);
      expect(
        whole.items.map((i) => i.museum.slug),
        list,
      ).toEqual(seen);
    }
    // The visit order: newest month first, the undated one last.
    const { body } = await json('/users/paged_one/visits');
    expect(PublicVisitList.parse(body).items.map((i) => i.visited_month)).toEqual([
      '2026-09',
      '2026-09',
      '2026-09',
      '2026-08',
      null,
    ]);
  });

  it('answers a bad cursor or an unknown parameter with a 400', async () => {
    await p.newMember({ handle: 'strict_one', settings: PUBLIC });
    for (const q of ['cursor=!!', 'cursor=e30', 'limit=0', 'limit=51', 'x=1', 'limit=1&limit=2']) {
      for (const list of ['visits', 'wishlist']) {
        const r = await get(`/users/strict_one/${list}?${q}`);
        expect(r.status, `${list}?${q}`).toBe(400);
        expect(r.headers.get('cache-control')).toBe('private, no-store');
      }
    }
    // A wishlist cursor is no month: the visit log refuses it.
    const r = await get(
      `/users/strict_one/visits?cursor=${Buffer.from(JSON.stringify({ m: 'n', k: 'abc', i: crypto.randomUUID() })).toString('base64url')}`,
    );
    expect(r.status).toBe(400);
  });
});

describe('a private member', () => {
  it('has a profile with null progress, visits and wishlist, and 404 on both lists', async () => {
    const u = await p.newMember({ handle: 'closed_one' });
    await p.addVisit(u.id, (await p.visible()).id, { ageHours: 48 });
    await p.addWishlist(u.id, (await p.visible(1)).id);
    const { body } = await json('/users/closed_one');
    expect(UserProfile.parse(body)).toMatchObject({
      handle: 'closed_one',
      progress: null,
      visits: null,
      wishlist: null,
    });
    for (const list of ['visits', 'wishlist']) {
      const r = await get(`/users/closed_one/${list}`);
      expect(r.status).toBe(404);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('can share the wishlist and keep the visits private', async () => {
    const u = await p.newMember({ handle: 'half_one', settings: { wishlist_visibility: 'public' } });
    await p.addWishlist(u.id, (await p.visible()).id);
    const profile = UserProfile.parse((await json('/users/half_one')).body);
    expect(profile.visits).toBeNull();
    expect(profile.progress).toBeNull();
    expect(profile.wishlist?.items).toHaveLength(1);
    expect((await get('/users/half_one/visits')).status).toBe(404);
    expect((await get('/users/half_one/wishlist')).status).toBe(200);
  });
});

describe('a member that cannot be seen', () => {
  it('banned, deleted, unknown and malformed handles are 404 on all three routes', async () => {
    for (const status of ['banned', 'deleted']) {
      const u = await p.newMember({ handle: `${status}_one`, status, settings: PUBLIC });
      await p.addVisit(u.id, (await p.visible()).id, { ageHours: 48 });
      await p.addWishlist(u.id, (await p.visible()).id);
    }
    const handles = [
      'banned_one',
      'deleted_one',
      'nobody_here',
      'Open_One',
      'ab',
      'a'.repeat(31),
      'with-dash',
      '%C3%A9',
      '..',
    ];
    for (const h of handles)
      for (const sub of ['', '/visits', '/wishlist']) {
        const r = await get(`/users/${h}${sub}`);
        expect(r.status, `${h}${sub}`).toBe(404);
        expect(r.headers.get('cache-control')).toBe('private, no-store');
        expect(await r.json()).toEqual({ error: 'not_found' });
      }
  });
});
