import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { memberWithReview } from '../reviews/fixtures.ts';

// P3b WP1 (db/migrations/20261130000001_media.sql): who may do what with the media tables, per login and per
// column; what pub_media and pub_museum_image show; and the partial-index proof of A§8's [U P3b].

const TABLES = ['media', 'media_chunk', 'media_variant', 'blocked_hash', 'museum_image'] as const;
const VIEWS = ['pub_media', 'pub_museum_image'] as const;
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const SHA = Buffer.alloc(32, 9);

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(() => p.close());

const sorted = (xs: readonly string[]) => [...xs].sort();
const tablePrivs = async (login: string, rel: string) =>
  (
    await p.owner.query<{ priv: string; has: boolean }>(
      'SELECT x AS priv, has_table_privilege($1, $2, x) AS has FROM unnest($3::text[]) AS x',
      [login, `public.${rel}`, [...PRIVS]],
    )
  ).rows
    .filter((r) => r.has)
    .map((r) => r.priv);
/** The columns a login holds a privilege on, whether table-level (every column) or column-level. */
const colPrivs = async (login: string, table: string, privilege: 'SELECT' | 'INSERT' | 'UPDATE') =>
  (
    await p.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3`,
      [table, login, privilege],
    )
  ).rows
    .map((r) => r.column_name)
    .sort();
const columnsOf = async (table: string) =>
  (
    await p.owner.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      [table],
    )
  ).rows.map((r) => r.column_name);

describe('grants', () => {
  const EXPECTED: Record<string, Record<string, string[]>> = {
    mjk_api: {
      media: ['SELECT', 'INSERT', 'DELETE'],
      media_chunk: ['SELECT', 'INSERT', 'DELETE'],
      media_variant: ['SELECT'],
      blocked_hash: ['SELECT'],
      museum_image: ['SELECT'],
    },
    mjk_worker: {
      media: ['SELECT', 'DELETE'],
      media_variant: ['SELECT', 'INSERT', 'DELETE'],
      museum_image: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    },
    mjk_ssr: {},
  };

  it.each(Object.keys(EXPECTED))(
    '%s holds exactly its table privileges, never TRUNCATE, REFERENCES or TRIGGER',
    async (login) => {
      for (const t of TABLES)
        expect(sorted(await tablePrivs(login, t)), `${login} on ${t}`).toEqual(sorted(EXPECTED[login]?.[t] ?? []));
    },
  );

  it('mjk_ssr reads the two views and nothing of the tables, not even a column', async () => {
    for (const v of VIEWS) expect(await tablePrivs('mjk_ssr', v), v).toEqual(['SELECT']);
    for (const t of TABLES)
      for (const priv of ['SELECT', 'INSERT', 'UPDATE'] as const)
        expect(await colPrivs('mjk_ssr', t, priv), `${t} ${priv}`).toEqual([]);
    await expect(p.pools.ssr.query('SELECT 1 FROM media')).rejects.toMatchObject({ code: '42501' });
    await expect(p.pools.ssr.query('SELECT 1 FROM media_variant')).rejects.toMatchObject({ code: '42501' });
    await expect(p.pools.ssr.query('SELECT 1 FROM museum_image')).rejects.toMatchObject({ code: '42501' });
  });

  it('mjk_api and mjk_worker read both views', async () => {
    for (const login of ['mjk_api', 'mjk_worker'])
      for (const v of VIEWS)
        expect(await tablePrivs(login, v), `${login} ${v}`).toEqual(login === 'mjk_api' ? ['SELECT'] : []);
  });

  it('column grants: media', async () => {
    const all = sorted(await columnsOf('media'));
    expect(await colPrivs('mjk_api', 'media', 'SELECT')).toEqual(all);
    expect(await colPrivs('mjk_api', 'media', 'INSERT')).toEqual(all);
    expect(await colPrivs('mjk_api', 'media', 'UPDATE')).toEqual(
      sorted(['state', 'review_id', 'alt_text', 'sha256', 'error_code']),
    );
    expect(await colPrivs('mjk_worker', 'media', 'SELECT')).toEqual(all);
    expect(await colPrivs('mjk_worker', 'media', 'INSERT')).toEqual([]);
    expect(await colPrivs('mjk_worker', 'media', 'UPDATE')).toEqual(
      sorted(['state', 'width', 'height', 'public_key', 'error_code', 'decided_at']),
    );
  });

  it('column grants: museum_image and app_user', async () => {
    expect(await colPrivs('mjk_api', 'museum_image', 'UPDATE')).toEqual(['state']);
    expect(await colPrivs('mjk_api', 'museum_image', 'INSERT')).toEqual([]);
    expect(await colPrivs('mjk_worker', 'museum_image', 'UPDATE')).toEqual(sorted(await columnsOf('museum_image')));
    expect(await colPrivs('mjk_api', 'app_user', 'UPDATE')).toContain('trusted_at');
    expect(await colPrivs('mjk_worker', 'app_user', 'UPDATE')).toEqual([]);
    expect(await colPrivs('mjk_worker', 'app_user', 'SELECT')).toContain('trusted_at');
    expect(await colPrivs('mjk_worker', 'app_user', 'SELECT')).not.toContain('password_hash');
    expect(await colPrivs('mjk_ssr', 'app_user', 'SELECT')).toEqual([]);
  });

  it('a login cannot write what it holds no column grant on', async () => {
    const denied = async (pool: typeof p.pools.api, sql: string) =>
      expect(pool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    for (const col of [
      'user_id',
      'museum_id',
      'sha256',
      'width',
      'public_key',
      'decided_by',
      'updated_at',
      'created_at',
    ])
      if (col !== 'sha256') await denied(p.pools.api, `UPDATE media SET ${col} = ${col} WHERE false`);
    for (const col of ['user_id', 'sha256', 'review_id', 'alt_text', 'decided_by', 'updated_at', 'consents_at'])
      await denied(p.pools.worker, `UPDATE media SET ${col} = ${col} WHERE false`);
    await denied(p.pools.api, 'UPDATE media_variant SET bytes = bytes WHERE false');
    await denied(p.pools.api, 'DELETE FROM blocked_hash');
    await denied(p.pools.worker, 'SELECT 1 FROM blocked_hash');
    await denied(p.pools.worker, 'SELECT 1 FROM media_chunk');
  });
});

describe('pub_media', () => {
  let seq = 0;
  const key = () => (seq++ + 1000).toString(16).padStart(32, '0');
  async function photo(userId: string, museumId: string, reviewId: string | null, state: string, withAvif = true) {
    const approved = state === 'approved' || state === 'pending_review';
    const r = await p.owner.query<{ id: string }>(
      `INSERT INTO media (user_id, museum_id, review_id, type, state, declared_size, chunk_count, consents_at,
                          sha256, width, height, public_key, alt_text)
       VALUES ($1, $2, $3, 'image/jpeg', $4, 1000, 1, now(), $5, $6, $7, $8, 'Een schilderij') RETURNING id`,
      [
        userId,
        museumId,
        reviewId,
        state,
        state === 'uploading' || state === 'removed' || state === 'failed' ? null : SHA,
        approved ? 800 : null,
        approved ? 600 : null,
        approved ? key() : null,
      ],
    );
    const id = (r.rows[0] as { id: string }).id;
    if (withAvif) {
      for (const [fmt, w] of [
        ['avif', 1200],
        ['avif', 320],
        ['webp', 640],
      ] as const)
        await p.owner.query(
          'INSERT INTO media_variant (media_id, format, width, object_key, bytes) VALUES ($1, $2, $3, $4, 5)',
          [id, fmt, w, `p/${key()}/${w}.${fmt}`],
        );
    }
    return id;
  }
  const visibleIds = async (reviewId: string) =>
    (await p.pools.ssr.query<{ id: string }>('SELECT id FROM pub_media WHERE review_id = $1', [reviewId])).rows.map(
      (r) => r.id,
    );

  it('shows an approved photo of a visible review, with the ascending AVIF widths and no private column', async () => {
    const m = await p.visible(5);
    const rv = await memberWithReview(p, m.id);
    const id = await photo(rv.userId, m.id, rv.reviewId, 'approved');
    const r = await p.pools.ssr.query('SELECT * FROM pub_media WHERE id = $1', [id]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      id,
      review_id: rv.reviewId,
      museum_id: m.id,
      author_handle: rv.handle,
      width: 800,
      height: 600,
      alt_text: 'Een schilderij',
      widths: [320, 1200],
    });
    expect(Object.keys(r.rows[0]).sort()).toEqual(
      sorted([
        'id',
        'review_id',
        'museum_id',
        'author_handle',
        'width',
        'height',
        'alt_text',
        'public_key',
        'widths',
        'created_at',
      ]),
    );
    const viaApi = await p.pools.api.query('SELECT id FROM pub_media WHERE id = $1', [id]);
    expect(viaApi.rows).toHaveLength(1);
  });

  it('hides every state but approved', async () => {
    const m = await p.visible(6);
    const rv = await memberWithReview(p, m.id);
    for (const s of ['uploading', 'quarantined', 'processing', 'pending_review', 'rejected', 'removed', 'failed'])
      await photo(rv.userId, m.id, rv.reviewId, s);
    expect(await visibleIds(rv.reviewId)).toEqual([]);
  });

  it('hides the photo of a removed review, a hidden museum and a deleted author', async () => {
    const m = await p.visible(7);
    const removed = await memberWithReview(p, m.id);
    const id1 = await photo(removed.userId, m.id, removed.reviewId, 'approved');
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [removed.reviewId]);
    expect(await visibleIds(removed.reviewId)).toEqual([]);

    const m2 = await p.visible(8);
    const rv2 = await memberWithReview(p, m2.id);
    await photo(rv2.userId, m2.id, rv2.reviewId, 'approved');
    expect(await visibleIds(rv2.reviewId)).toHaveLength(1);
    await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [m2.id]);
    expect(await visibleIds(rv2.reviewId)).toEqual([]);
    await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [m2.id]);

    const m3 = await p.visible(9);
    const rv3 = await memberWithReview(p, m3.id);
    await photo(rv3.userId, m3.id, rv3.reviewId, 'approved');
    await p.owner.query("UPDATE app_user SET status = 'deleted' WHERE id = $1", [rv3.userId]);
    expect(await visibleIds(rv3.reviewId)).toEqual([]);
    expect(id1).toBeTruthy();
  });

  it("shows a banned author's photo with no handle", async () => {
    const m = await p.visible(10);
    const rv = await memberWithReview(p, m.id, { status: 'banned' });
    await photo(rv.userId, m.id, rv.reviewId, 'approved');
    const r = await p.pools.ssr.query('SELECT author_handle FROM pub_media WHERE review_id = $1', [rv.reviewId]);
    expect(r.rows).toEqual([{ author_handle: null }]);
  });

  it('a photo without a review is not public', async () => {
    const m = await p.visible(11);
    const u = (await p.newMember()).id;
    const id = await photo(u, m.id, null, 'approved');
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_media WHERE id = $1', [id])).rowCount).toBe(0);
  });

  it('A§8 [U P3b]: a review_id qual reaches only the partial index, so no pending row is filtered away', async () => {
    const m = await p.visible(12);
    const rv = await memberWithReview(p, m.id);
    await photo(rv.userId, m.id, rv.reviewId, 'approved');
    await photo(rv.userId, m.id, rv.reviewId, 'pending_review');
    await photo(rv.userId, m.id, rv.reviewId, 'pending_review');
    await p.owner.query('VACUUM (ANALYZE) media');
    const c = await p.pools.ssr.connect();
    try {
      // The tables are tiny, so the planner would scan sequentially (and the filter would then show the rows
      // it removes). The point is what the index a leakproof qual reaches holds: only approved rows.
      await c.query('SET enable_seqscan = off');
      const r = await c.query<{ 'QUERY PLAN': unknown[] }>(
        'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM pub_media WHERE review_id = $1',
        [rv.reviewId],
      );
      // The joined review, museum and user nodes may report a filter (0 rows here); the media scan must not.
      const nodes: Record<string, unknown>[] = [];
      const walk = (n: Record<string, unknown>) => {
        nodes.push(n);
        for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
      };
      walk(
        (r.rows[0] as unknown as Record<'QUERY PLAN', { Plan: Record<string, unknown> }[]>)['QUERY PLAN'][0]?.Plan ??
          {},
      );
      const scan = nodes.find((n) => n['Relation Name'] === 'media');
      expect(scan?.['Index Name']).toBe('media_review_approved_idx');
      expect(scan).not.toHaveProperty('Rows Removed by Filter');
      expect(scan?.['Actual Rows']).toBe(1);
    } finally {
      c.release();
    }
  });
});

describe('pub_museum_image', () => {
  it('shows active rows of visible museums, with the public columns only', async () => {
    const m = await p.visible(13);
    const hid = await p.hidden();
    const row = (id: string, state: string, k: string) =>
      p.owner.query(
        `INSERT INTO museum_image (museum_id, file, sha1, licence, attribution, public_key, width, height, widths, state)
         VALUES ($1, 'A.jpg', $2, 'cc0', 'Jane', $3, 1200, 800, '{320,640}', $4)`,
        [id, 'c'.repeat(40), k, state],
      );
    await row(m.id, 'active', 'd'.repeat(32));
    await row(hid.id, 'active', 'e'.repeat(32));
    const shown = await p.pools.ssr.query('SELECT * FROM pub_museum_image');
    expect(shown.rows).toHaveLength(1);
    expect(shown.rows[0]).toEqual({
      museum_id: m.id,
      file: 'A.jpg',
      licence: 'cc0',
      attribution: 'Jane',
      public_key: 'd'.repeat(32),
      width: 1200,
      height: 800,
      widths: [320, 640],
    });
    await p.owner.query("UPDATE museum_image SET state = 'hidden' WHERE museum_id = $1", [m.id]);
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_museum_image')).rowCount).toBe(0);
  });
});
