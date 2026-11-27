import { PublicVisitList, PublicWishlist, UserProfile } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type Mount, mountCatalogue } from '../../src/api/app.ts';
import { mountMe } from '../../src/api/routes/me.ts';
import { mountMeVisits } from '../../src/api/routes/me-visits.ts';
import { mountMeWishlist } from '../../src/api/routes/me-wishlist.ts';
import { mountUsers } from '../../src/api/routes/users.ts';
import { createDb } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { meApp } from './me-app.ts';

// P2c criteria 6 and 7 (A§10, A§13, invariant 5): what a member keeps private reaches no public surface, what
// they publish is shown by month only and after 24 hours, and a note is the owner's alone. Every public
// surface is read twice, as the api would serve it (mjk_api) and as ssr does (mjk_ssr, the real in-process
// path): the profile routes, the server-rendered /u/<handle> page, the sitemap, every pub_* view and function.

const MARKER = 'NOTE-MARKER-4c1e9f';
const PUBLIC = { visits_visibility: 'public', wishlist_visibility: 'public' };

let p: PassportDb;
let owner: ReturnType<typeof meApp>;
let apiUsers: ReturnType<typeof buildApp>;
let ssrUsers: ReturnType<typeof buildApp>;
let ssr: ReturnType<typeof createSsrApp>;

const mountOwner: Mount = (v1, d) => {
  mountMe(v1, d);
  mountMeVisits(v1, d);
  mountMeWishlist(v1, d);
  mountUsers(v1, d);
};

beforeAll(async () => {
  p = await openPassportDb();
  owner = meApp(p, mountOwner);
  apiUsers = buildApp({ db: p.db, logger: silentLogger, ping: async () => true }, mountUsers);
  const ssrDb = createDb(p.pools.ssr);
  ssrUsers = buildApp({ db: ssrDb, logger: silentLogger, ping: async () => true }, mountCatalogue);
  const bundle = await loadBundle();
  if (typeof bundle === 'string') throw new Error(`the web build is ${bundle}`);
  ssr = createSsrApp({
    bundle,
    fetchApi: inProcessApi(ssrDb, silentLogger),
    db: ssrDb,
    config: { brand: 'Musea Test', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' },
    logger: silentLogger,
  });
}, 120_000);
afterAll(async () => {
  await p?.close();
});

type Surface = { status: number; text: string };
/** One path, as both api apps answer it and as the ssr's page for the same member. */
const apiGet = async (app: ReturnType<typeof buildApp>, path: string): Promise<Surface> => {
  const r = await app.request(`http://localhost/api/v1${path}`);
  return { status: r.status, text: await r.text() };
};
const html = async (path: string): Promise<Surface> => {
  const r = await ssr.request(`http://mjk.test${path}`);
  return { status: r.status, text: await r.text() };
};
/** Both api apps must give the same status and body. */
async function users(path: string): Promise<Surface> {
  const [a, s] = [await apiGet(apiUsers, `/users${path}`), await apiGet(ssrUsers, `/users${path}`)];
  expect(s, `/users${path}: api and ssr differ`).toEqual(a);
  return a;
}

/** Every pub_* view, read whole as mjk_ssr; the list comes from pg_views, so a new view is covered. */
async function viewsText(): Promise<string> {
  const names = (
    await p.admin.query<{ viewname: string }>(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'pub\\_%' ORDER BY 1`,
    )
  ).rows.map((r) => r.viewname);
  expect(names).toContain('pub_profile');
  const parts: string[] = [];
  for (const n of names) parts.push(JSON.stringify((await p.pools.ssr.query(`SELECT * FROM ${n}`)).rows));
  return parts.join('\n');
}

/** The pub_* functions: each must be one that this test knows how to call, so a new one fails here until covered. */
async function functionsText(handle: string): Promise<{ text: string; log: unknown[]; wishlist: unknown[] }> {
  const names = (
    await p.admin.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'pub\\_%' ORDER BY 1`,
    )
  ).rows.map((r) => r.proname);
  expect(names).toEqual([
    'pub_review',
    'pub_reviews_of_museum',
    'pub_reviews_of_user',
    'pub_search',
    'pub_visit_log',
    'pub_wishlist_of',
  ]);
  const log = (await p.pools.ssr.query('SELECT * FROM pub_visit_log($1)', [handle])).rows;
  const wishlist = (await p.pools.ssr.query('SELECT * FROM pub_wishlist_of($1)', [handle])).rows;
  const search = (await p.pools.ssr.query('SELECT * FROM pub_search($1)', [MARKER])).rows;
  return { text: JSON.stringify([log, wishlist, search]), log, wishlist };
}

const sitemap = () => html('/sitemap.xml');
const noneOf = (text: string, needles: string[], what: string) => {
  for (const n of needles) expect(text, `${what} holds ${n}`).not.toContain(n);
};

describe('a private visit log and wishlist (criterion 6)', () => {
  it('appear in no profile answer, page, sitemap, view or function, and the note is the owner’s alone', async () => {
    const priv = await p.newMember({ handle: 'priv_one' });
    const pub = await p.newMember({ handle: 'open_two', settings: PUBLIC });
    const a = await p.visible(0);
    const b = await p.visible(1);
    const c = await p.visible(2);
    const d = await p.visible(3);
    const visit = await p.addVisit(priv.id, a.id, {
      on: '2026-11-15',
      note: MARKER,
      ageHours: 48,
    });
    await p.addWishlist(priv.id, b.id);
    await p.addVisit(pub.id, c.id, { on: '2026-10-03', note: MARKER, ageHours: 48 });
    await p.addWishlist(pub.id, d.id);
    const A = a.slug;
    const B = b.slug;
    const C = c.slug;
    const D = d.slug;
    // What may never appear on a public surface, for either member.
    const secrets = [MARKER, priv.id, priv.email, pub.id, pub.email, visit, '2026-11-15', '2026-10-03'];
    const surfaces: string[] = [];

    // 1. The private member: a profile with nothing shared, two 404s, and none of their museums anywhere.
    const profile = await users('/priv_one');
    expect(profile.status).toBe(200);
    expect(UserProfile.parse(JSON.parse(profile.text))).toMatchObject({
      handle: 'priv_one',
      progress: null,
      visits: null,
      wishlist: null,
    });
    expect((await users('/priv_one/visits')).status).toBe(404);
    expect((await users('/priv_one/wishlist')).status).toBe(404);
    const page = await html('/u/priv_one');
    expect(page.status).toBe(200);
    surfaces.push(profile.text, page.text);
    for (const s of [A, B]) {
      expect(profile.text).not.toContain(`"${s}"`);
      expect(page.text).not.toContain(`/musea/${s}"`);
    }
    const map = await sitemap();
    expect(map.status).toBe(200);
    expect(map.text).not.toContain('priv_one');
    surfaces.push(map.text);
    const fns = await functionsText('priv_one');
    expect(fns.log).toEqual([]);
    expect(fns.wishlist).toEqual([]);
    surfaces.push(fns.text, await viewsText());

    // 2. The public member shows by month and name only, never the day or the note.
    const open = await users('/open_two');
    const openProfile = UserProfile.parse(JSON.parse(open.text));
    expect(openProfile.visits?.items.map((i) => [i.museum.slug, i.visited_month])).toEqual([[C, '2026-10']]);
    expect(openProfile.wishlist?.items.map((i) => i.museum.slug)).toEqual([D]);
    expect(PublicVisitList.parse(JSON.parse((await users('/open_two/visits')).text)).items).toHaveLength(1);
    expect(PublicWishlist.parse(JSON.parse((await users('/open_two/wishlist')).text)).items).toHaveLength(1);
    const openPage = await html('/u/open_two');
    expect(openPage.text).toContain(`/musea/${C}"`);
    expect(openPage.text).toContain('oktober 2026');
    expect(openPage.text).not.toContain('3 oktober');
    surfaces.push(open.text, openPage.text, (await functionsText('open_two')).text);

    // 3. The note is in the owner's own answers and in no other.
    const token = await owner.signIn(priv.id);
    const own = await owner.call('/me/visits', { token });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain(MARKER);
    noneOf(surfaces.join('\n'), secrets, 'a public surface');
  });

  it('become visible, by month, when the member makes them public, and vanish when private again', async () => {
    const priv = await p.newMember({ handle: 'turned_on' });
    const a = await p.visible(10);
    const b = await p.visible(11);
    const visit = await p.addVisit(priv.id, a.id, { on: '2026-11-15', note: MARKER, ageHours: 48 });
    await p.addWishlist(priv.id, b.id);
    const token = await owner.signIn(priv.id);
    const set = (visibility: 'public' | 'private') =>
      owner.call('/me', {
        method: 'PATCH',
        token,
        body: { settings: { visits_visibility: visibility, wishlist_visibility: visibility } },
      });

    expect((await users('/turned_on/visits')).status).toBe(404);
    expect((await set('public')).status).toBe(200);
    const shown = await users('/turned_on');
    const profile = UserProfile.parse(JSON.parse(shown.text));
    expect(profile.visits?.items.map((i) => [i.museum.slug, i.visited_month])).toEqual([[a.slug, '2026-11']]);
    expect(profile.wishlist?.items.map((i) => i.museum.slug)).toEqual([b.slug]);
    const page = await html('/u/turned_on');
    expect(page.text).toContain(`/musea/${a.slug}"`);
    expect(page.text).toContain(`/musea/${b.slug}"`);
    expect(page.text).toContain('november 2026');
    expect(page.text).not.toContain('15 november');
    const fns = await functionsText('turned_on');
    // The month and the count, nothing finer: the three columns of the function.
    expect(fns.log).toEqual([{ museum_id: a.id, visited_month: '2026-11', visits: '1' }]);
    noneOf(
      [shown.text, page.text, fns.text, await viewsText(), (await sitemap()).text].join('\n'),
      [MARKER, '2026-11-15', visit, priv.id, priv.email],
      'a public surface',
    );

    expect((await set('private')).status).toBe(200);
    expect((await users('/turned_on/visits')).status).toBe(404);
    expect((await users('/turned_on/wishlist')).status).toBe(404);
    expect((await html('/u/turned_on')).text).not.toContain(`/musea/${a.slug}"`);
    expect((await functionsText('turned_on')).log).toEqual([]);
  });
});

describe('the 24-hour delay on a public visit log (criterion 7)', () => {
  it('hides a visit logged under 24 hours ago and shows it, by month, after that', async () => {
    const u = await p.newMember({ handle: 'fresh_one', settings: PUBLIC });
    const e = await p.visible(20);
    const token = await owner.signIn(u.id);
    // Logged through the route, so created_at is now.
    const made = await owner.call('/me/visits', {
      token,
      body: { museum_id: e.id, visited_on: '2026-11-20', note: MARKER },
    });
    expect(made.status).toBe(201);
    const shownAt = async () => {
      const list = PublicVisitList.parse(JSON.parse((await users('/fresh_one/visits')).text));
      const page = await html('/u/fresh_one');
      return { list, page: page.text, fns: await functionsText('fresh_one') };
    };

    let s = await shownAt();
    expect(s.list.items).toEqual([]);
    expect(s.page).not.toContain(`/musea/${e.slug}"`);
    expect(s.fns.log).toEqual([]);

    // 23 hours old: still hidden. 25 hours old: shown.
    await p.owner.query(`UPDATE visit SET created_at = now() - interval '23 hours' WHERE user_id = $1`, [u.id]);
    expect((await shownAt()).list.items).toEqual([]);
    await p.owner.query(`UPDATE visit SET created_at = now() - interval '25 hours' WHERE user_id = $1`, [u.id]);
    s = await shownAt();
    expect(s.list.items.map((i) => [i.museum.slug, i.visited_month])).toEqual([[e.slug, '2026-11']]);
    expect(s.page).toContain(`/musea/${e.slug}"`);
    expect(s.page).toContain('november 2026');
    expect(s.page).not.toContain('20 november');
    expect(s.fns.log).toEqual([{ museum_id: e.id, visited_month: '2026-11', visits: '1' }]);
    noneOf(JSON.stringify(s) + (await users('/fresh_one')).text, [MARKER, '2026-11-20'], 'a public surface');
  });
});
