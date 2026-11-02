import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readCsv, writeCsv } from '../../src/museums/csv.ts';
import { type Harness, openHarness } from '../admin/harness.ts';

let h: Harness;
let ids: string[];

beforeAll(async () => {
  h = await openHarness();
  ids = await h.seed([
    { slug: 'a-museum', name: 'A Museum', qid: 'Q101', place: 'Leiden' },
    { slug: 'b-museum', name: 'B Museum', qid: 'Q102', place: 'Delft' },
    { slug: 'c-museum', name: '=HYPERLINK("x")', qid: 'Q103', place: 'Gouda' },
    { slug: 'd-museum', name: 'D, "quoted"\nmuseum', qid: null },
  ]);
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  // Every case starts from the same museums; the change log is the only thing it may leave behind.
  await h.api.query(
    `UPDATE museum SET museumkaart_status = 'unknown', mk_since = NULL, mk_until = NULL, mk_last_verified_at = NULL,
       admission_adult_cents = NULL, price_verified_at = NULL, photo_policy = 'unknown', closed_on = NULL,
       temp_closed = false, temp_closed_until = NULL, hidden = false, pinned_fields = '{}'`,
  );
  // mjk_api cannot delete (by design), so the setup clears the change log as the database owner.
  const owner = new pg.Client({ connectionString: h.db.urls.admin });
  await owner.connect();
  try {
    await owner.query('TRUNCATE museum_change');
  } finally {
    await owner.end();
  }
  h.files.clear();
});

const snapshot = async () => ({
  museums: (await h.api.query('SELECT * FROM museum ORDER BY slug')).rows,
  changes: (await h.api.query('SELECT count(*)::int AS n FROM museum_change')).rows,
});
const changesOf = async (slug: string) =>
  (
    await h.api.query<{ field: string; old: unknown; new: unknown; origin: string; state: string; decided: boolean }>(
      `SELECT c.field, c.old, c.new, c.origin, c.state, (c.decided_at IS NOT NULL AND c.decided_by IS NULL) AS decided
       FROM museum_change c JOIN museum m ON m.id = c.museum_id WHERE m.slug = $1 ORDER BY c.field`,
      [slug],
    )
  ).rows;
const row = async (slug: string) =>
  (
    await h.api.query(
      `SELECT museumkaart_status, mk_since::text, mk_until::text, extract(epoch FROM mk_last_verified_at)::bigint AS verified,
         admission_adult_cents, extract(epoch FROM price_verified_at)::bigint AS price_verified, hidden
       FROM museum WHERE slug = $1`,
      [slug],
    )
  ).rows[0];

const exported = async (): Promise<string[][]> => {
  expect((await h.admin('museum', 'export', '--csv', 'm.csv')).code).toBe(0);
  const parsed = readCsv(h.files.get('m.csv') as string);
  if (!parsed.ok) throw new Error('unreadable export');
  return parsed.rows;
};
const importRows = (rows: string[][], ...flags: string[]) => {
  h.files.set('in.csv', writeCsv(rows));
  return h.admin('museum', 'import', '--csv', 'in.csv', ...flags);
};
const col = (rows: string[][], name: string) => (rows[0] as string[]).indexOf(name);
const set = (rows: string[][], slug: string, name: string, value: string) => {
  const r = rows.find((x) => x[col(rows, 'slug')] === slug) as string[];
  r[col(rows, name)] = value;
};

it('flag without dates sets the status and a verified time of now, and logs each changed column', async () => {
  const before = Date.now() / 1000;
  const r = await h.admin('museum', 'flag', 'Q101', 'participating');
  expect(r.code).toBe(0);
  const got = await row('a-museum');
  expect(got).toMatchObject({ museumkaart_status: 'participating', mk_since: null, mk_until: null });
  expect(Number(got.verified)).toBeGreaterThanOrEqual(before - 1);
  const log = await changesOf('a-museum');
  expect(log.map((c) => c.field)).toEqual(['mk_last_verified_at', 'museumkaart_status']);
  expect(log.every((c) => c.origin === 'admin' && c.state === 'applied' && c.decided)).toBe(true);
  expect(log.find((c) => c.field === 'museumkaart_status')).toMatchObject({ old: 'unknown', new: 'participating' });
});

it('flag with dates (by slug and by id) stores the start of the verified day in Amsterdam', async () => {
  const r = await h.admin(
    'museum',
    'flag',
    'b-museum',
    'left',
    '--since',
    '2020-01-01',
    '--until',
    '2026-06-30',
    '--verified',
    '2026-07-01',
  );
  expect(r.code).toBe(0);
  const got = await row('b-museum');
  expect(got).toMatchObject({ museumkaart_status: 'left', mk_since: '2020-01-01', mk_until: '2026-06-30' });
  expect(Number(got.verified)).toBe(Date.parse('2026-06-30T22:00:00Z') / 1000);
  expect((await changesOf('b-museum')).map((c) => c.field)).toEqual([
    'mk_last_verified_at',
    'mk_since',
    'mk_until',
    'museumkaart_status',
  ]);
  expect((await h.admin('museum', 'flag', ids[0] as string, 'participating')).code).toBe(0);
});

it('flag: left without --until is 64, until before since is 65, and neither writes', async () => {
  const before = await snapshot();
  expect((await h.admin('museum', 'flag', 'Q101', 'left')).code).toBe(64);
  const r = await h.admin('museum', 'flag', 'Q101', 'left', '--since', '2020-05-01', '--until', '2020-04-01');
  expect(r.code).toBe(65);
  expect(await snapshot()).toEqual(before);
});

it('leave, then rejoin: participating or unknown clears mk_until unless --until is given', async () => {
  const untilLog = async () =>
    (
      await h.api.query<{ old: unknown; new: unknown }>(
        `SELECT c.old, c.new FROM museum_change c JOIN museum m ON m.id = c.museum_id
         WHERE m.slug = 'a-museum' AND c.field = 'mk_until' ORDER BY c.id`,
      )
    ).rows.map((c) => [c.old, c.new]);
  const left = await h.admin('museum', 'flag', 'Q101', 'left', '--since', '2019-01-01', '--until', '2026-06-30');
  expect(left.code).toBe(0);
  expect(await row('a-museum')).toMatchObject({
    museumkaart_status: 'left',
    mk_since: '2019-01-01',
    mk_until: '2026-06-30',
  });
  const rejoined = await h.admin('museum', 'flag', 'Q101', 'participating');
  expect(rejoined.code).toBe(0);
  expect(rejoined.out[0]).toContain('mk_until');
  expect(await row('a-museum')).toMatchObject({
    museumkaart_status: 'participating',
    mk_since: '2019-01-01',
    mk_until: null,
  });
  expect(await untilLog()).toEqual([
    [null, '2026-06-30'],
    ['2026-06-30', null],
  ]);
  // A given --until stays; unknown without one clears it again.
  expect((await h.admin('museum', 'flag', 'Q101', 'unknown', '--until', '2027-01-01')).code).toBe(0);
  expect(await row('a-museum')).toMatchObject({ museumkaart_status: 'unknown', mk_until: '2027-01-01' });
  expect((await h.admin('museum', 'flag', 'Q101', 'unknown')).code).toBe(0);
  expect(await row('a-museum')).toMatchObject({ museumkaart_status: 'unknown', mk_until: null });
  expect((await untilLog()).length).toBe(4);
});

it('price sets, bounds and clears, with its change rows', async () => {
  expect((await h.admin('museum', 'price', 'Q102', '1500', '--verified', '2026-03-01')).code).toBe(0);
  expect(await row('b-museum')).toMatchObject({ admission_adult_cents: 1500 });
  expect((await changesOf('b-museum')).map((c) => [c.field, c.old, c.new])).toEqual([
    ['admission_adult_cents', null, 1500],
    ['price_verified_at', null, '2026-02-28T23:00:00.000Z'],
  ]);
  expect((await h.admin('museum', 'price', 'Q102', '20001')).code).toBe(65);
  expect((await h.admin('museum', 'price', 'Q102', '-1')).code).toBe(65);
  expect((await h.admin('museum', 'price', 'Q102', '0')).code).toBe(0);
  expect((await h.admin('museum', 'price', 'Q102', '20000')).code).toBe(0);
  expect((await h.admin('museum', 'price', 'Q102', '--clear')).code).toBe(0);
  expect(await row('b-museum')).toMatchObject({ admission_adult_cents: null });
  expect((await changesOf('b-museum')).filter((c) => c.field === 'admission_adult_cents').length).toBe(4);
});

it('pin adds fields to pinned_fields, --unpin removes them, lat and lon go together, and it is idempotent', async () => {
  const pinned = async () =>
    (await h.api.query<{ p: string[] }>("SELECT pinned_fields AS p FROM museum WHERE slug = 'a-museum'")).rows[0]?.p;
  const r = await h.admin('museum', 'pin', 'a-museum', 'website', 'lat', 'name');
  expect(r.code).toBe(0);
  expect(r.out).toEqual(['a-museum (A Museum): changed, pinned: name, lat, lon, website']);
  expect(await pinned()).toEqual(['name', 'lat', 'lon', 'website']);
  // The same again writes nothing.
  const again = await h.admin('museum', 'pin', 'a-museum', 'website');
  expect(again.out).toEqual(['a-museum (A Museum): no change, pinned: name, lat, lon, website']);
  const r2 = await h.admin('museum', 'pin', 'a-museum', 'lon', 'name', '--unpin');
  expect(r2.code).toBe(0);
  expect(await pinned()).toEqual(['website']);
  expect((await h.admin('museum', 'pin', 'a-museum', 'street', '--unpin')).out).toEqual([
    'a-museum (A Museum): no change, pinned: website',
  ]);
  const log = await changesOf('a-museum');
  expect(log.map((c) => [c.field, c.origin, c.state, c.decided])).toEqual([
    ['pinned_fields', 'admin', 'applied', true],
    ['pinned_fields', 'admin', 'applied', true],
  ]);
  expect(log.map((c) => [c.old, c.new]).sort()).toEqual(
    [
      [[], ['name', 'lat', 'lon', 'website']],
      [['name', 'lat', 'lon', 'website'], ['website']],
    ].sort(),
  );
});

it('pin refuses a field the sync does not write (65), a missing field (64) and an unknown museum (66)', async () => {
  const before = await snapshot();
  for (const field of ['wikidata_qid', 'museumkaart_status', 'hidden', 'pinned_fields', 'coordinates', 'nope']) {
    const r = await h.admin('museum', 'pin', 'a-museum', 'website', field);
    expect(r.code).toBe(65);
    expect(r.err).toEqual(['admin: not_pinnable']);
  }
  expect((await h.admin('museum', 'pin', 'a-museum')).code).toBe(64);
  expect((await h.admin('museum', 'pin', 'no-such-museum', 'website')).code).toBe(66);
  expect(await snapshot()).toEqual(before);
});

it('an unknown museum is 66, however it is named', async () => {
  const before = await snapshot();
  for (const ref of ['Q999', 'no-such-museum', '019a0000-0000-7000-8000-000000000000', 'Not A Ref!']) {
    expect((await h.admin('museum', 'flag', ref, 'participating')).code).toBe(66);
    expect((await h.admin('museum', 'price', ref, '100')).code).toBe(66);
  }
  expect(await snapshot()).toEqual(before);
});

it('export lists every museum by slug; a name starting with = is prefixed and still imports', async () => {
  const rows = await exported();
  expect(rows[0]).toEqual([
    'id',
    'wikidata_qid',
    'slug',
    'name',
    'place',
    'museumkaart_status',
    'mk_since',
    'mk_until',
    'mk_last_verified_at',
    'admission_adult_cents',
    'price_verified_at',
    'photo_policy',
    'closed_on',
    'temp_closed',
    'temp_closed_until',
    'hidden',
  ]);
  expect(rows.slice(1).map((r) => r[2])).toEqual(['a-museum', 'b-museum', 'c-museum', 'd-museum']);
  expect(rows[3]?.[3]).toBe('\'=HYPERLINK("x")');
  expect(rows[4]?.[3]).toBe('D, "quoted"\nmuseum');
  expect(rows[1]?.slice(5)).toEqual(['unknown', '', '', '', '', '', 'unknown', '', 'false', '', 'false']);
  const before = await snapshot();
  const r = await importRows(rows);
  expect(r.code).toBe(0);
  expect(await snapshot()).toEqual(before);
});

it('importing the unchanged export writes nothing', async () => {
  await h.admin('museum', 'flag', 'Q101', 'participating', '--since', '2019-01-01');
  await h.admin('museum', 'price', 'Q102', '1250');
  const before = await snapshot();
  const rows = await exported();
  const r = await importRows(rows);
  expect(r.code).toBe(0);
  expect(r.out[0]).toBe('4 rows read, 0 rows changed');
  expect(await snapshot()).toEqual(before);
});

it('an edited file writes exactly the changed cells', async () => {
  const rows = await exported();
  set(rows, 'a-museum', 'hidden', 'true');
  set(rows, 'b-museum', 'mk_since', '2018-05-05');
  set(rows, 'b-museum', 'photo_policy', 'no_flash');
  set(rows, 'b-museum', 'admission_adult_cents', '999');
  set(rows, 'b-museum', 'price_verified_at', '2026-03-01T10:30:00+01:00');
  set(rows, 'c-museum', 'temp_closed', 'true');
  set(rows, 'c-museum', 'temp_closed_until', '2027-01-15');
  const r = await importRows(rows);
  expect(r.code).toBe(0);
  expect(r.out).toEqual([
    '4 rows read, 3 rows changed',
    '  mk_since: 1',
    '  admission_adult_cents: 1',
    '  price_verified_at: 1',
    '  photo_policy: 1',
    '  temp_closed: 1',
    '  temp_closed_until: 1',
    '  hidden: 1',
  ]);
  expect((await changesOf('a-museum')).map((c) => c.field)).toEqual(['hidden']);
  expect((await changesOf('b-museum')).map((c) => c.field)).toEqual([
    'admission_adult_cents',
    'mk_since',
    'photo_policy',
    'price_verified_at',
  ]);
  expect((await changesOf('c-museum')).map((c) => c.field)).toEqual(['temp_closed', 'temp_closed_until']);
  expect(await changesOf('d-museum')).toEqual([]);
  expect(await row('b-museum')).toMatchObject({ mk_since: '2018-05-05', admission_adult_cents: 999 });
  expect(Number((await row('b-museum')).price_verified)).toBe(Date.parse('2026-03-01T09:30:00Z') / 1000);
});

it('a shifted row refuses the whole file and changes nothing', async () => {
  const rows = await exported();
  set(rows, 'a-museum', 'hidden', 'true'); // a valid edit that must not be written either
  set(rows, 'b-museum', 'wikidata_qid', 'Q101'); // the QID of the row above
  const before = await snapshot();
  const r = await importRows(rows);
  expect(r.code).toBe(65);
  expect(r.err).toContain('  row 3 wikidata_qid: qid_mismatch');
  expect(await snapshot()).toEqual(before);
});

it('one bad cell refuses the whole file, names the row and column, and never shows the value', async () => {
  const rows = await exported();
  set(rows, 'a-museum', 'hidden', 'true');
  set(rows, 'c-museum', 'museumkaart_status', 'MAYBE-SECRET');
  const before = await snapshot();
  const r = await importRows(rows);
  expect(r.code).toBe(65);
  expect(r.err).toContain('  row 4 museumkaart_status: invalid');
  expect(r.err.join('\n')).not.toContain('MAYBE-SECRET');
  expect(await snapshot()).toEqual(before);
});

it('an unknown id, a bad header and an unbalanced quote refuse the file', async () => {
  const before = await snapshot();
  const rows = await exported();
  set(rows, 'a-museum', 'id', '019a0000-0000-7000-8000-000000000000');
  expect((await importRows(rows)).err).toContain('  row 2 id: unknown_id');
  const bad = await exported();
  (bad[0] as string[])[5] = 'status';
  expect((await importRows(bad)).code).toBe(65);
  h.files.set('in.csv', 'id,"wikidata_qid\r\n');
  expect((await h.admin('museum', 'import', '--csv', 'in.csv')).code).toBe(65);
  expect(await snapshot()).toEqual(before);
});

it('a CHECK violation (left without mk_until) is check_failed and writes nothing', async () => {
  const rows = await exported();
  set(rows, 'a-museum', 'hidden', 'true');
  set(rows, 'b-museum', 'museumkaart_status', 'left');
  const before = await snapshot();
  const r = await importRows(rows);
  expect(r.code).toBe(65);
  expect(r.err).toContain('  row 3: check_failed');
  expect(await snapshot()).toEqual(before);
});

it('--dry-run reports the counts and changes nothing', async () => {
  const rows = await exported();
  set(rows, 'a-museum', 'hidden', 'true');
  set(rows, 'b-museum', 'photo_policy', 'forbidden');
  const before = await snapshot();
  const r = await importRows(rows, '--dry-run');
  expect(r.code).toBe(0);
  expect(r.out).toEqual(['dry run: nothing written, 4 rows read, 2 rows changed', '  photo_policy: 1', '  hidden: 1']);
  expect(await snapshot()).toEqual(before);
});
