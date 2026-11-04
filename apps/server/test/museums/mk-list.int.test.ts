import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { todayAmsterdam } from '../../src/admin/dates.ts';
import { type Harness, openHarness } from '../admin/harness.ts';

// Criterion 7 (A§7.5): N is the count of the newest version's members, and only a new version changes it.

let h: Harness;
let ids: string[];

const members = async (date: string) =>
  (
    await h.api.query<{ museum_id: string }>(
      `SELECT m.museum_id FROM mk_list_member m JOIN mk_list_version v ON v.id = m.list_version_id
       WHERE v.published_on = $1 ORDER BY m.museum_id`,
      [date],
    )
  ).rows.map((r) => r.museum_id);
const view = async () =>
  (await h.api.query<{ n: string; published_on: string }>('SELECT n, published_on::text AS published_on FROM mk_list'))
    .rows;

beforeAll(async () => {
  h = await openHarness();
  ids = await h.seed([
    { slug: 'one', name: 'One', status: 'participating' },
    { slug: 'two', name: 'Two', status: 'participating' },
    { slug: 'three', name: 'Three', status: 'participating', hidden: true },
    { slug: 'four', name: 'Four' },
    { slug: 'five', name: 'Five' },
  ]);
});
afterAll(async () => {
  await h?.close();
});

it('shows no list before the first publish', async () => {
  const r = await h.admin('list', 'show');
  expect(r.code).toBe(0);
  expect(r.out).toEqual(['no list published']);
  expect(await view()).toEqual([]);
});

it('publishes the participating, visible museums: N is the count of the newest version members', async () => {
  const r = await h.admin('list', 'publish', '--date', '2026-09-01');
  expect(r.code).toBe(0);
  expect(await members('2026-09-01')).toEqual([ids[0], ids[1]].sort());
  expect(await view()).toEqual([{ n: '2', published_on: '2026-09-01' }]);
  expect((await h.admin('list', 'show')).out).toEqual(['N = 2, list of 2026-09-01']);
});

it('changing a status afterwards leaves N, its date and the members unchanged', async () => {
  expect((await h.admin('museum', 'flag', 'one', 'left', '--until', '2026-11-03')).code).toBe(0);
  expect((await h.admin('museum', 'flag', 'four', 'participating')).code).toBe(0);
  expect(await view()).toEqual([{ n: '2', published_on: '2026-09-01' }]);
  expect(await members('2026-09-01')).toEqual([ids[0], ids[1]].sort());
});

it('refuses a second version on the same date', async () => {
  const r = await h.admin('list', 'publish', '--date', '2026-09-01');
  expect(r.code).toBe(65);
  expect(r.err[0]).toBe('admin: list_exists');
  expect(await view()).toEqual([{ n: '2', published_on: '2026-09-01' }]);
});

it('a new version is the only thing that changes N or its date; the old members stay', async () => {
  expect((await h.admin('list', 'publish', '--date', '2026-10-01')).code).toBe(0);
  expect(await view()).toEqual([{ n: '2', published_on: '2026-10-01' }]);
  expect(await members('2026-10-01')).toEqual([ids[1], ids[3]].sort());
  expect(await members('2026-09-01')).toEqual([ids[0], ids[1]].sort());
});

it('refuses a date after today (Amsterdam) and one not after the newest version: a version is never removed', async () => {
  const today = todayAmsterdam();
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const future = await h.admin('list', 'publish', '--date', tomorrow);
  expect(future.code).toBe(65);
  expect(future.err).toEqual(['admin: list_in_future']);
  const older = await h.admin('list', 'publish', '--date', '2026-09-15');
  expect(older.code).toBe(65);
  expect(older.err).toEqual(['admin: list_not_newest']);
  expect((await h.admin('list', 'publish', '--date', '2020-01-01')).err).toEqual(['admin: list_not_newest']);
  const { rows } = await h.api.query('SELECT published_on::text AS d FROM mk_list_version ORDER BY 1');
  expect(rows).toEqual([{ d: '2026-09-01' }, { d: '2026-10-01' }]);
  expect(await view()).toEqual([{ n: '2', published_on: '2026-10-01' }]);
  // Today itself is fine, and is the default.
  const r = await h.admin('list', 'publish');
  expect(r.code).toBe(0);
  expect(r.out).toEqual([`published list of ${today}: N = 2`]);
});

it('mjk_worker can neither publish a version nor change the Museumkaart flag', async () => {
  const worker = new pg.Client({ connectionString: h.db.urls.mjk_worker });
  await worker.connect();
  try {
    await expect(
      worker.query("INSERT INTO mk_list_version (published_on) VALUES ('2027-01-01')"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(worker.query("UPDATE museum SET museumkaart_status = 'participating'")).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await worker.end();
  }
});

it('refuses an empty list', async () => {
  const empty = await openHarness();
  try {
    await empty.seed([
      { slug: 'x', name: 'X' },
      { slug: 'y', name: 'Y', status: 'participating', hidden: true },
    ]);
    const r = await empty.admin('list', 'publish', '--date', '2026-09-01');
    expect(r.code).toBe(65);
    expect(r.err[0]).toBe('admin: list_empty');
    const { rows } = await empty.api.query('SELECT 1 FROM mk_list_version');
    expect(rows).toEqual([]);
  } finally {
    await empty.close();
  }
});
