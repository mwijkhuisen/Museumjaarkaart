import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c WP1 (db/migrations/20261128000001_passport.sql): the passport tables' constraints and what the
// public sees through pub_profile, pub_mk_list_province, pub_visit_log and pub_wishlist_of.

const UNIQUE = '23505';
const CHECK = '23514';
const DENIED = '42501';

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(() => p.close());

const code = (q: Promise<unknown>) =>
  q.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? 'error',
  );
const ssr = (sql: string, params: unknown[] = []) => p.pools.ssr.query(sql, params);
const log = async (handle: string) =>
  (await ssr('SELECT museum_id, visited_month, visits::int AS visits FROM pub_visit_log($1) ORDER BY 1, 2', [handle]))
    .rows as { museum_id: string; visited_month: string | null; visits: number }[];
const wishlist = async (handle: string) =>
  (await ssr('SELECT museum_id FROM pub_wishlist_of($1)', [handle])).rows.map((r) => r.museum_id as string);
const PUBLIC = { visits_visibility: 'public', wishlist_visibility: 'public' };

describe('constraints, as mjk_api', () => {
  const insertVisit = (userId: string, museumId: string, on: string | null, extra: Record<string, unknown> = {}) =>
    code(
      p.pools.api.query(
        'INSERT INTO visit (user_id, museum_id, visited_on, source, note) VALUES ($1, $2, $3, $4, $5)',
        [userId, museumId, on, extra.source ?? 'manual', extra.note ?? null],
      ),
    );

  it('one visit per member, museum and date, and one undated visit per museum', async () => {
    const u = await p.newMember();
    const m = await p.visible();
    expect(await insertVisit(u.id, m.id, null)).toBe('ok');
    expect(await insertVisit(u.id, m.id, null)).toBe(UNIQUE);
    expect(await insertVisit(u.id, m.id, '2026-03-01')).toBe('ok');
    expect(await insertVisit(u.id, m.id, '2026-03-01')).toBe(UNIQUE);
    expect(await insertVisit(u.id, m.id, '2026-03-02')).toBe('ok');
    const other = await p.newMember();
    expect(await insertVisit(other.id, m.id, null)).toBe('ok');
  });

  it('a note is 1 to 2,000 characters and the source is known', async () => {
    const u = await p.newMember();
    const m = await p.visible(1);
    expect(await insertVisit(u.id, m.id, '2026-01-01', { note: 'x'.repeat(2000) })).toBe('ok');
    expect(await insertVisit(u.id, m.id, '2026-01-02', { note: 'x'.repeat(2001) })).toBe(CHECK);
    expect(await insertVisit(u.id, m.id, '2026-01-03', { note: '' })).toBe(CHECK);
    expect(await insertVisit(u.id, m.id, '2026-01-04', { source: 'scraped' })).toBe(CHECK);
    for (const [i, source] of ['manual', 'bulk', 'import'].entries())
      expect(await insertVisit(u.id, m.id, `2026-02-0${i + 1}`, { source })).toBe('ok');
  });

  it('an import is pending or confirmed (with its time), and a member has one pending import', async () => {
    const u = await p.newMember();
    const ins = (extra: string, params: unknown[] = []) =>
      code(p.pools.api.query(`INSERT INTO visit_import (user_id, format, rows ${extra}`, [u.id, ...params]));
    expect(await ins(") VALUES ($1, 'csv', '[]')")).toBe('ok');
    expect(await ins(") VALUES ($1, 'csv', '[]')")).toBe(UNIQUE);
    expect(await ins(") VALUES ($1, 'xls', '[]')")).toBe(CHECK);
    expect(await ins(") VALUES ($1, 'csv', '{}')")).toBe(CHECK);
    expect(await ins(", state) VALUES ($1, 'csv', '[]', 'confirmed')")).toBe(CHECK);
    expect(await ins(", state, confirmed_at) VALUES ($1, 'csv', '[]', 'confirmed', now())")).toBe('ok');
    expect(await ins(", confirmed_at) VALUES ($1, 'mjk', '[]', now())")).toBe(CHECK);
  });

  it('an export is queued, ready (with its expiry) or failed, and a member has one queued export', async () => {
    const u = await p.newMember();
    const ins = (extra: string) => code(p.pools.api.query(`INSERT INTO data_export (user_id ${extra}`, [u.id]));
    expect(await ins(') VALUES ($1)')).toBe('ok');
    expect(await ins(') VALUES ($1)')).toBe(UNIQUE);
    expect(await ins(", state) VALUES ($1, 'ready')")).toBe(CHECK);
    expect(await ins(", state, expires_at) VALUES ($1, 'ready', now())")).toBe('ok');
    expect(await ins(", state) VALUES ($1, 'failed')")).toBe('ok');
    expect(await ins(", state) VALUES ($1, 'gone')")).toBe(CHECK);
  });
});

describe('pub_visit_log', () => {
  it('truncates to the month, counts visits per month and gives undated visits a null month', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    const a = await p.visible(2);
    const b = await p.visible(3);
    await p.addVisit(u.id, a.id, { on: '2026-03-02', ageHours: 48 });
    await p.addVisit(u.id, a.id, { on: '2026-03-28', ageHours: 48 });
    await p.addVisit(u.id, a.id, { on: '2026-04-01', ageHours: 48 });
    await p.addVisit(u.id, b.id, { on: null, ageHours: 48 });
    const rows = await log(u.handle);
    const of = (id: string) => rows.filter((r) => r.museum_id === id).map((r) => [r.visited_month, r.visits]);
    expect(of(a.id)).toEqual([
      ['2026-03', 2],
      ['2026-04', 1],
    ]);
    expect(of(b.id)).toEqual([[null, 1]]);
    expect(rows).toHaveLength(3);
  });

  it('shows a visit only from 24 hours after it was logged (owner, Q1)', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    const m = await p.visible(4);
    const id = await p.addVisit(u.id, m.id, { on: '2026-06-01' });
    expect(await log(u.handle)).toEqual([]);
    await p.owner.query("UPDATE visit SET created_at = now() - interval '23 hours' WHERE id = $1", [id]);
    expect(await log(u.handle)).toEqual([]);
    await p.owner.query("UPDATE visit SET created_at = now() - interval '25 hours' WHERE id = $1", [id]);
    expect(await log(u.handle)).toEqual([{ museum_id: m.id, visited_month: '2026-06', visits: 1 }]);
  });

  it('shows nothing of a private member, a missing setting, a banned or deleted member or an unknown handle', async () => {
    const m = await p.visible(5);
    const cases = [
      await p.newMember({ settings: { visits_visibility: 'private' } }),
      await p.newMember({ settings: { wishlist_visibility: 'public' } }),
      await p.newMember({ settings: {} }),
      await p.newMember({ settings: { visits_visibility: true } }),
      await p.newMember({ settings: PUBLIC, status: 'banned' }),
      await p.newMember({ settings: PUBLIC, status: 'deleted' }),
    ];
    for (const u of cases) await p.addVisit(u.id, m.id, { ageHours: 48 });
    for (const u of cases) expect(await log(u.handle), u.handle).toEqual([]);
    expect(await log('nobody_here')).toEqual([]);
  });

  it('drops a hidden museum and keeps the member visible museums', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    const shown = await p.visible(6);
    const hidden = await p.hidden();
    await p.addVisit(u.id, shown.id, { ageHours: 48 });
    await p.addVisit(u.id, hidden.id, { ageHours: 48 });
    expect((await log(u.handle)).map((r) => r.museum_id)).toEqual([shown.id]);
  });
});

describe('pub_wishlist_of', () => {
  it('lists a public wishlist without delay, and drops hidden museums', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    const shown = await p.visible(7);
    await p.addWishlist(u.id, shown.id);
    await p.addWishlist(u.id, (await p.hidden()).id);
    expect(await wishlist(u.handle)).toEqual([shown.id]);
  });

  it('shows nothing of a private member, a missing setting, a banned or deleted member or an unknown handle', async () => {
    const m = await p.visible(8);
    const cases = [
      await p.newMember({ settings: { wishlist_visibility: 'private' } }),
      await p.newMember({ settings: { visits_visibility: 'public' } }),
      await p.newMember({ settings: {} }),
      await p.newMember({ settings: PUBLIC, status: 'banned' }),
      await p.newMember({ settings: PUBLIC, status: 'deleted' }),
    ];
    for (const u of cases) await p.addWishlist(u.id, m.id);
    for (const u of cases) expect(await wishlist(u.handle), u.handle).toEqual([]);
    expect(await wishlist('nobody_here')).toEqual([]);
  });
});

describe('pub_profile', () => {
  it('lists active members only, with the month and the three flags', async () => {
    const full = await p.newMember({
      settings: { visits_visibility: 'public', wishlist_visibility: 'public', profile_indexable: true },
    });
    const bare = await p.newMember({ settings: {} });
    const odd = await p.newMember({ settings: { visits_visibility: 'yes', profile_indexable: 'true' } });
    const banned = await p.newMember({ settings: PUBLIC, status: 'banned' });
    const deleted = await p.newMember({ settings: PUBLIC, status: 'deleted' });
    await p.owner.query("UPDATE app_user SET created_at = '2026-07-31 23:30:00+00' WHERE id = $1", [full.id]);

    const row = async (handle: string) =>
      (await ssr('SELECT * FROM pub_profile WHERE handle = $1', [handle])).rows[0] as
        | Record<string, unknown>
        | undefined;
    // 23:30 UTC on 31 July is already August in Amsterdam
    expect(await row(full.handle)).toEqual({
      handle: full.handle,
      display_name: 'Member',
      member_since: '2026-08',
      visits_public: true,
      wishlist_public: true,
      indexable: true,
    });
    expect(await row(bare.handle)).toMatchObject({ visits_public: false, wishlist_public: false, indexable: false });
    expect(await row(odd.handle)).toMatchObject({ visits_public: false, wishlist_public: false, indexable: false });
    expect(await row(banned.handle)).toBeUndefined();
    expect(await row(deleted.handle)).toBeUndefined();
  });

  it('has exactly the public columns', async () => {
    const { rows } = await p.owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'pub_profile' ORDER BY ordinal_position",
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'handle',
      'display_name',
      'member_since',
      'visits_public',
      'wishlist_public',
      'indexable',
    ]);
  });
});

describe('pub_mk_list_province', () => {
  it('sums to the published N, hidden museums included, and splits by province', async () => {
    const { rows: prov } = await ssr('SELECT province_code, n FROM pub_mk_list_province');
    const { rows: list } = await ssr('SELECT n FROM pub_mk_list');
    expect(prov.reduce((s, r) => s + (r.n as number), 0)).toBe(list[0]?.n);
    expect(list[0]?.n).toBe(p.catalogue.list.n);
    expect(prov.filter((r) => r.province_code !== null).length).toBeGreaterThan(1);
    // the member hidden after publication is still counted
    const { rows: hiddenMembers } = await p.owner.query(
      `SELECT 1 FROM mk_list l JOIN mk_list_member mm ON mm.list_version_id = l.list_version_id
         JOIN museum m ON m.id = mm.museum_id WHERE m.hidden`,
    );
    expect(hiddenMembers.length).toBeGreaterThan(0);
  });
});

describe('mjk_ssr', () => {
  it('cannot read visit, wishlist, the imports or the exports, only the views and functions', async () => {
    for (const t of ['visit', 'wishlist', 'visit_import', 'data_export'])
      expect(await code(ssr(`SELECT 1 FROM ${t} LIMIT 1`)), t).toBe(DENIED);
    expect(await code(ssr('SELECT 1 FROM pub_profile LIMIT 1'))).toBe('ok');
    expect(await code(ssr('SELECT 1 FROM pub_mk_list_province LIMIT 1'))).toBe('ok');
  });

  it('EXPLAIN (ANALYZE) of a visit log shows a function scan and no filtered rows', async () => {
    const u = await p.newMember({ settings: PUBLIC });
    await p.addVisit(u.id, (await p.visible(9)).id);
    const { rows } = await ssr('EXPLAIN (ANALYZE) SELECT * FROM pub_visit_log($1)', [u.handle]);
    const plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    expect(plan).toContain('Function Scan on pub_visit_log');
    expect(plan).not.toContain('Rows Removed');
  });
});
