import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, openHarness } from '../admin/harness.ts';

// `admin museum slug` (owner decision Q1): the slug changes only through it; the keep trigger writes
// the redirect, the guard refuses another museum's old slug; `match resolve --new` never takes one.

let h: Harness;
let owner: pg.Client;
let ids: string[];

const redirects = async () =>
  (
    await h.api.query<{ old_slug: string; museum_id: string }>(
      'SELECT old_slug, museum_id FROM museum_slug_redirect ORDER BY old_slug',
    )
  ).rows;
const slugOf = async (id: string) =>
  (await h.api.query<{ slug: string }>('SELECT slug FROM museum WHERE id = $1', [id])).rows[0]?.slug;

beforeAll(async () => {
  h = await openHarness();
  owner = new pg.Client({ connectionString: h.db.urls.admin });
  await owner.connect();
  ids = await h.seed([
    { slug: 'alpha', name: 'Alpha Museum', place: 'Utrecht', qid: 'Q1' },
    { slug: 'beta', name: 'Beta Museum' },
    { slug: 'gamma', name: 'Gamma Museum' },
  ]);
});
afterAll(async () => {
  await owner?.end();
  await h?.close();
});

describe('admin museum slug', () => {
  it('changes a slug, prints old -> new and keeps the old one as a redirect', async () => {
    const r = await h.admin('museum', 'slug', 'alpha', 'alpha-2');
    expect(r).toEqual({ code: 0, out: ['alpha -> alpha-2'], err: [] });
    expect(await slugOf(ids[0] as string)).toBe('alpha-2');
    expect(await redirects()).toEqual([{ old_slug: 'alpha', museum_id: ids[0] }]);
  });

  it('finds the museum by QID or id as well', async () => {
    expect((await h.admin('museum', 'slug', 'Q1', 'alpha-3')).out).toEqual(['alpha-2 -> alpha-3']);
    expect((await h.admin('museum', 'slug', ids[0] as string, 'alpha-4')).out).toEqual(['alpha-3 -> alpha-4']);
    expect((await redirects()).map((x) => x.old_slug)).toEqual(['alpha', 'alpha-2', 'alpha-3']);
  });

  it('prints no change for the same slug and writes nothing', async () => {
    const before = await redirects();
    expect(await h.admin('museum', 'slug', 'alpha-4', 'alpha-4')).toEqual({ code: 0, out: ['no change'], err: [] });
    expect(await redirects()).toEqual(before);
  });

  it('derives the slug from the name with --from-name (unique: -place when taken)', async () => {
    // "alpha-museum" is free: the museum's own old slugs and current slug do not count.
    expect((await h.admin('museum', 'slug', 'Q1', '--from-name')).out).toEqual(['alpha-4 -> alpha-museum']);
    expect((await h.admin('museum', 'slug', 'Q1', '--from-name')).out).toEqual(['no change']);
    // Another museum holds it now: Beta takes its name, then Alpha's name collides with nothing.
    await h.seed([{ slug: 'alpha-museum-x', name: 'Delta Museum', place: 'Zwolle' }]);
    expect((await h.admin('museum', 'slug', 'beta', '--from-name')).out).toEqual(['beta -> beta-museum']);
  });

  it('refuses a bad slug with exit 65 bad_slug', async () => {
    for (const bad of ['Bad_Slug', '-x', 'x-', 'a--b', 'a'.repeat(121), 'ünï']) {
      const r = await h.admin('museum', 'slug', 'gamma', bad);
      expect(r).toEqual({ code: 65, out: [], err: ['admin: bad_slug'] });
    }
    expect(await slugOf(ids[2] as string)).toBe('gamma');
  });

  it("refuses another museum's current slug and old slug with exit 65 slug_taken", async () => {
    expect(await h.admin('museum', 'slug', 'gamma', 'beta-museum')).toEqual({
      code: 65,
      out: [],
      err: ['admin: slug_taken'],
    });
    expect(await h.admin('museum', 'slug', 'gamma', 'alpha')).toEqual({
      code: 65,
      out: [],
      err: ['admin: slug_taken'],
    });
    expect(await slugOf(ids[2] as string)).toBe('gamma');
  });

  it("the guard trigger refuses another museum's old slug in the database too (23505)", async () => {
    await expect(h.api.query('UPDATE museum SET slug = $2 WHERE id = $1', [ids[2], 'alpha'])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('lets a museum take back one of its own old slugs', async () => {
    expect((await h.admin('museum', 'slug', 'Q1', 'alpha')).out).toEqual(['alpha-museum -> alpha']);
    expect(await slugOf(ids[0] as string)).toBe('alpha');
    expect((await redirects()).map((x) => x.old_slug)).toContain('alpha-museum');
  });

  it('reports an unknown museum as exit 66', async () => {
    expect((await h.admin('museum', 'slug', 'nope', 'x')).code).toBe(66);
  });
});

describe('match resolve --new', () => {
  it('never chooses an old slug', async () => {
    // "Gamma Museum" has slug `gamma`; rename it so that `gamma-museum` becomes an old slug.
    expect((await h.admin('museum', 'slug', 'gamma', 'gamma-museum')).code).toBe(0);
    expect((await h.admin('museum', 'slug', 'gamma-museum', 'gamma-renamed')).code).toBe(0);
    expect((await redirects()).map((x) => x.old_slug)).toContain('gamma-museum');
    const run = await owner.query<{ id: string }>(
      "INSERT INTO museum_sync_run (mode, outcome) VALUES ('sync', 'applied') RETURNING id",
    );
    await owner.query(
      `INSERT INTO museum_source_row (source, external_id, payload, hash, run_id, match_state, match_reason)
       VALUES ('rce', 'rce.900', $1, repeat('a', 64), $2, 'new', 'no_candidate')`,
      [
        JSON.stringify({
          rceId: 'rce.900',
          name: 'Gamma Museum',
          street: null,
          houseNumber: null,
          postcode: null,
          place: null,
          municipalityName: null,
          lat: null,
          lon: null,
        }),
        (run.rows[0] as { id: string }).id,
      ],
    );
    const r = await h.admin('match', 'resolve', 'rce:rce.900', '--new');
    expect(r.code).toBe(0);
    // `gamma-museum` is an old slug (and would otherwise be free): the next free one is taken.
    expect(r.out).toEqual(['rce:rce.900 created gamma-museum-2']);
  });
});
