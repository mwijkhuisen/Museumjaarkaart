import { ImportPreview, ImportResult } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeImports } from '../../src/api/routes/me-imports.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c criterion 3: a CSV or mjk file over the seeded catalogue is previewed with matched, ambiguous and
// unmatched rows; confirming applies only what is matched or chosen, and importing the same file twice
// adds nothing, undated rows included.

let p: PassportDb;
let app: ReturnType<typeof meApp>;
beforeAll(async () => {
  p = await openPassportDb();
  app = meApp(p, mountMeImports);
}, 120_000);
afterAll(() => p.close());

const post = async (token: string, format: 'csv' | 'mjk', content: string) => {
  const r = await app.call('/me/imports', { token, body: { format, content } });
  expect(r.status).toBe(201);
  return ImportPreview.parse(await r.json());
};
const confirm = async (token: string, id: string, body: object = { choose: [], skip: [] }) => {
  const r = await app.call(`/me/imports/${id}/confirm`, { token, body });
  expect(r.status).toBe(200);
  return ImportResult.parse(await r.json());
};
const visitsOf = async (userId: string) =>
  (
    await p.owner.query<{ museum_id: string; visited_on: string | null; note: string | null; source: string }>(
      `SELECT museum_id, to_char(visited_on, 'YYYY-MM-DD') AS visited_on, note, source FROM visit
        WHERE user_id = $1 ORDER BY museum_id, visited_on`,
      [userId],
    )
  ).rows;

// Two visible museums share a name; a third has a name of its own; the rest of the catalogue is as seeded.
const DOUBLE = 'Dubbelganger Testmuseum';
const UNIQUE = 'Uniek Testnaam Quokka';
let ids: { first: string; unique: string; twinA: string; twinB: string; other: string };
beforeAll(async () => {
  const m = async (n: number) => (await p.visible(n)).id;
  ids = { first: await m(0), unique: await m(1), twinA: await m(2), twinB: await m(3), other: await m(4) };
  await p.owner.query('UPDATE museum SET name = $2, place = NULL WHERE id = $1', [ids.unique, UNIQUE]);
  await p.owner.query('UPDATE museum SET name = $3 WHERE id IN ($1, $2)', [ids.twinA, ids.twinB, DOUBLE]);
});

const FILE = [
  'museum_id,museum,plaats,datum,notitie',
  `{first},Wie weet,,2026-05-01,eerste`, // rule 1: the id
  `,${UNIQUE},,,`, // rule 3: a unique name, undated
  `,${DOUBLE},,2026-06-01,twee`, // ambiguous
  ',Bestaat Niet Zzz,,2026-07-01,', // unmatched
  ',Kapot,,gisteren,', // invalid
].join('\n');

describe('the CSV import', () => {
  it('previews matched, ambiguous, unmatched and invalid rows', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const preview = await post(token, 'csv', FILE.replace('{first}', ids.first));
    expect(preview.counts).toEqual({ matched: 2, ambiguous: 1, unmatched: 1, invalid: 1 });
    expect(preview.rows.map((r) => r.status)).toEqual(['matched', 'matched', 'ambiguous', 'unmatched', 'invalid']);
    expect(preview.rows[0]?.museum?.id).toBe(ids.first);
    expect(preview.rows[1]?.museum?.id).toBe(ids.unique);
    expect(preview.rows[2]?.museum).toBeNull();
    expect(preview.rows[2]?.candidates.map((c) => c.id).sort()).toEqual([ids.twinA, ids.twinB].sort());
    expect(preview.rows[4]?.error).toBe('bad_date');
    // Nothing is written until the member confirms.
    expect(await visitsOf(u.id)).toEqual([]);
  });

  it('confirming with no choice applies only the matched rows, and a second run adds nothing', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const file = FILE.replace('{first}', ids.first);
    const first = await post(token, 'csv', file);
    expect(await confirm(token, first.id)).toEqual({ visits: 2, wishlist: 0, reviews: 0, skipped: 0 });
    expect(await visitsOf(u.id)).toEqual(
      [
        { museum_id: ids.first, visited_on: '2026-05-01', note: 'eerste', source: 'import' },
        { museum_id: ids.unique, visited_on: null, note: null, source: 'import' },
      ].sort((a, b) => (a.museum_id < b.museum_id ? -1 : 1)),
    );

    // The same file again: nothing new, the undated row included.
    const again = await post(token, 'csv', file);
    expect(await confirm(token, again.id)).toEqual({ visits: 0, wishlist: 0, reviews: 0, skipped: 2 });
    expect(await visitsOf(u.id)).toHaveLength(2);
  });

  it('a chosen museum applies for an ambiguous or unmatched row; skip drops a matched one', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const preview = await post(token, 'csv', FILE.replace('{first}', ids.first));
    const result = await confirm(token, preview.id, {
      choose: [
        { row: 3, museum_id: ids.twinB },
        { row: 4, museum_id: ids.other },
      ],
      skip: [1],
    });
    expect(result).toEqual({ visits: 3, wishlist: 0, reviews: 0, skipped: 0 });
    expect((await visitsOf(u.id)).map((v) => v.museum_id).sort()).toEqual([ids.unique, ids.twinB, ids.other].sort());
    const twice = await post(token, 'csv', FILE.replace('{first}', ids.first));
    expect(await confirm(token, twice.id, { choose: [{ row: 3, museum_id: ids.twinB }], skip: [] })).toEqual({
      visits: 1,
      wishlist: 0,
      reviews: 0,
      skipped: 2,
    });
  });

  it('a hidden museum is not matched by id, and cannot be chosen', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const hidden = await p.hidden();
    const preview = await post(token, 'csv', `museum_id\n${hidden.id}\n`);
    expect(preview.rows[0]).toMatchObject({ status: 'unmatched', museum: null });
    const r = await app.call(`/me/imports/${preview.id}/confirm`, {
      token,
      body: { choose: [{ row: 1, museum_id: hidden.id }], skip: [] },
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['choose'] });
    // The failed confirm rolled back: the import is still pending and can be confirmed.
    expect(await confirm(token, preview.id)).toEqual({ visits: 0, wishlist: 0, reviews: 0, skipped: 0 });
  });
});

describe('the mjk import', () => {
  const entry = (id: string, name: string, extra: object = {}) => ({
    museum: { id, slug: 'x', name, place: null, wikidata_qid: null },
    ...extra,
  });

  it('fills the visits and the wishlist, and a second run adds nothing', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const file = JSON.stringify({
      format: 'mjk',
      version: 1,
      visits: [
        entry(ids.first, 'x', { visited_on: '2026-04-01', note: 'n' }),
        entry(ids.other, 'x', { visited_on: null }),
      ],
      wishlist: [entry(ids.unique, 'x'), entry(ids.twinA, 'x')],
    });
    const preview = await post(token, 'mjk', file);
    expect(preview.counts).toEqual({ matched: 4, ambiguous: 0, unmatched: 0, invalid: 0 });
    expect(preview.rows.map((r) => r.kind)).toEqual(['visit', 'visit', 'wishlist', 'wishlist']);
    expect(await confirm(token, preview.id)).toEqual({ visits: 2, wishlist: 2, reviews: 0, skipped: 0 });
    const wished = await p.owner.query('SELECT museum_id FROM wishlist WHERE user_id = $1', [u.id]);
    expect(wished.rows.map((r) => r.museum_id).sort()).toEqual([ids.unique, ids.twinA].sort());

    const again = await post(token, 'mjk', file);
    expect(await confirm(token, again.id)).toEqual({ visits: 0, wishlist: 0, reviews: 0, skipped: 4 });
  });
});
