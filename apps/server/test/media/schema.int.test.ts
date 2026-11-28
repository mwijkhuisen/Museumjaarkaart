import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { memberWithReview } from '../reviews/fixtures.ts';

// P3b WP1 (db/migrations/20261130000001_media.sql): the media tables' constraints, the RESTRICT and SET NULL
// rules, the cascades and the museum_image row CHECKs. Fixtures are the owner's (mjk_migrator).

const CHECK = '23514';
const UNIQUE = '23505';
// RESTRICT raises restrict_violation (NO ACTION would raise 23503).
const FK_RESTRICT = '23001';

let p: PassportDb;
let museumId: string;
let userId: string;
beforeAll(async () => {
  p = await openPassportDb();
  museumId = (await p.visible()).id;
  userId = (await p.newMember()).id;
}, 120_000);
afterAll(() => p.close());

const HEX = 'a'.repeat(32);
const SHA = Buffer.alloc(32, 7);
let seq = 0;
const key = () => (seq++).toString(16).padStart(32, '0');

/** One statement in a transaction that is always rolled back: 'ok' or its SQLSTATE. */
async function attempt(sql: string, params: unknown[] = []): Promise<string> {
  await p.owner.query('BEGIN');
  try {
    await p.owner.query(sql, params);
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    await p.owner.query('ROLLBACK');
  }
}
const insert = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return attempt(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  );
};
const base = (extra: Record<string, unknown> = {}) => ({
  user_id: userId,
  museum_id: museumId,
  type: 'image/jpeg',
  declared_size: 1000,
  chunk_count: 1,
  consents_at: new Date(),
  ...extra,
});
const published = (extra: Record<string, unknown> = {}) =>
  base({ state: 'approved', sha256: SHA, width: 800, height: 600, public_key: key(), ...extra });
/** Inserts a committed media row as the owner and returns its id. */
async function addMedia(extra: Record<string, unknown> = {}, uid = userId): Promise<string> {
  const row = base({ user_id: uid, ...extra });
  const cols = Object.keys(row);
  const r = await p.owner.query<{ id: string }>(
    `INSERT INTO media (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((c) => (row as Record<string, unknown>)[c]),
  );
  return (r.rows[0] as { id: string }).id;
}

describe('media', () => {
  it('takes a good row with its defaults', async () => {
    expect(await insert('media', base())).toBe('ok');
    const id = await addMedia();
    const r = await p.owner.query('SELECT kind, state FROM media WHERE id = $1', [id]);
    expect(r.rows[0]).toEqual({ kind: 'photo', state: 'uploading' });
  });

  it.each([
    ['kind', { kind: 'video' }],
    ['type', { type: 'image/heic' }],
    ['state', { state: 'deleted' }],
    ['declared_size 0', { declared_size: 0, chunk_count: 0 }],
    ['declared_size over 25 MiB', { declared_size: 26214401, chunk_count: 4 }],
    ['chunk_count too low', { declared_size: 8388609, chunk_count: 1 }],
    ['chunk_count too high', { declared_size: 8388608, chunk_count: 2 }],
    ['sha256 length', { sha256: Buffer.alloc(31) }],
    ['width 0', { width: 0 }],
    ['height over 100000', { height: 100001 }],
    ['public_key not hex32', { public_key: 'ABC' }],
    ['alt_text empty', { alt_text: '' }],
    ['alt_text 251', { alt_text: 'x'.repeat(251) }],
    ['alt_text control char', { alt_text: 'a\u0007b' }],
    ['alt_text bidi', { alt_text: 'a\u{202E}b' }],
    ['error_code digits', { error_code: 'bad2' }],
    ['uploaded with no sha256', { state: 'quarantined' }],
    ['pending_review without dimensions', { state: 'pending_review', sha256: SHA }],
    ['approved without public_key', { state: 'approved', sha256: SHA, width: 1, height: 1 }],
  ])('refuses %s', async (_n, extra) => {
    expect(await insert('media', base(extra))).toBe(CHECK);
  });

  it('takes the boundary values', async () => {
    for (const [size, chunks] of [
      [1, 1],
      [8388608, 1],
      [8388609, 2],
      [26214400, 4],
    ] as const)
      expect(await insert('media', base({ declared_size: size, chunk_count: chunks })), String(size)).toBe('ok');
    expect(await insert('media', base({ alt_text: 'x'.repeat(250), error_code: 'a_b' }))).toBe('ok');
    expect(await insert('media', base({ state: 'failed', error_code: 'decode_failed' }))).toBe('ok');
    expect(await insert('media', base({ state: 'removed' }))).toBe('ok');
    expect(await insert('media', published())).toBe('ok');
    expect(await insert('media', base({ state: 'processing', sha256: SHA }))).toBe('ok');
  });

  it('public_key is unique', async () => {
    await addMedia(published({ public_key: HEX }));
    expect(await insert('media', published({ public_key: HEX }))).toBe(UNIQUE);
  });

  it('RESTRICT: a user with a photo cannot be deleted', async () => {
    const u = (await p.newMember()).id;
    await addMedia({}, u);
    expect(await attempt('DELETE FROM app_user WHERE id = $1', [u])).toBe(FK_RESTRICT);
  });

  it('SET NULL: deleting the review keeps the photo, unattached', async () => {
    const m = await p.visible(1);
    const rv = await memberWithReview(p, m.id);
    const id = await addMedia({ user_id: rv.userId, museum_id: m.id, review_id: rv.reviewId }, rv.userId);
    await p.owner.query('DELETE FROM review WHERE id = $1', [rv.reviewId]);
    const r = await p.owner.query('SELECT review_id FROM media WHERE id = $1', [id]);
    expect(r.rows[0]).toEqual({ review_id: null });
  });

  it('decided_by is SET NULL when the decider goes', async () => {
    const decider = (await p.newMember()).id;
    const id = await addMedia({ decided_by: decider });
    await p.owner.query('DELETE FROM app_user WHERE id = $1', [decider]);
    expect((await p.owner.query('SELECT decided_by FROM media WHERE id = $1', [id])).rows[0]).toEqual({
      decided_by: null,
    });
  });

  it('updated_at moves on update', async () => {
    const id = await addMedia();
    await p.owner.query("UPDATE media SET updated_at = now() - interval '1 day' WHERE id = $1", [id]);
    // the trigger overrides an explicit value, so read after a plain update
    await p.owner.query("UPDATE media SET state = 'failed' WHERE id = $1", [id]);
    const r = await p.owner.query<{ fresh: boolean }>(
      "SELECT updated_at > now() - interval '1 minute' AS fresh FROM media WHERE id = $1",
      [id],
    );
    expect(r.rows[0]?.fresh).toBe(true);
  });

  it('chunk and variant rows cascade with the media row, also when the api or the worker deletes it', async () => {
    for (const pool of [p.pools.api, p.pools.worker]) {
      const id = await addMedia(published({ declared_size: 9_000_000, chunk_count: 2 }));
      await p.owner.query('INSERT INTO media_chunk (media_id, n, sha256) VALUES ($1, 0, $2), ($1, 1, $2)', [id, SHA]);
      await p.owner.query(
        "INSERT INTO media_variant (media_id, format, width, object_key, bytes) VALUES ($1, 'avif', 640, $2, 10)",
        [id, `p/${key()}/640.avif`],
      );
      await pool.query('DELETE FROM media WHERE id = $1', [id]);
      for (const t of ['media_chunk', 'media_variant'])
        expect((await p.owner.query(`SELECT 1 FROM ${t} WHERE media_id = $1`, [id])).rowCount, t).toBe(0);
    }
  });
});

describe('media_chunk', () => {
  it('checks n and the hash length, and (media_id, n) is the key', async () => {
    const id = await addMedia();
    expect(await insert('media_chunk', { media_id: id, n: 3, sha256: SHA })).toBe('ok');
    expect(await insert('media_chunk', { media_id: id, n: 4, sha256: SHA })).toBe(CHECK);
    expect(await insert('media_chunk', { media_id: id, n: -1, sha256: SHA })).toBe(CHECK);
    expect(await insert('media_chunk', { media_id: id, n: 0, sha256: Buffer.alloc(5) })).toBe(CHECK);
    await p.owner.query('INSERT INTO media_chunk (media_id, n, sha256) VALUES ($1, 0, $2)', [id, SHA]);
    expect(await insert('media_chunk', { media_id: id, n: 0, sha256: SHA })).toBe(UNIQUE);
  });
});

describe('media_variant', () => {
  it('checks format, width, object_key and bytes, and the keys are unique', async () => {
    const id = await addMedia();
    const v = (extra: Record<string, unknown> = {}) => ({
      media_id: id,
      format: 'avif',
      width: 640,
      object_key: `p/${key()}/640.avif`,
      bytes: 1000,
      ...extra,
    });
    expect(await insert('media_variant', v())).toBe('ok');
    expect(await insert('media_variant', v({ format: 'png' }))).toBe(CHECK);
    expect(await insert('media_variant', v({ width: 0 }))).toBe(CHECK);
    expect(await insert('media_variant', v({ width: 2001 }))).toBe(CHECK);
    expect(await insert('media_variant', v({ bytes: 0 }))).toBe(CHECK);
    expect(await insert('media_variant', v({ bytes: 67108865 }))).toBe(CHECK);
    for (const bad of [
      'p/ABC/640.avif',
      `p/${HEX}/640.jpg`,
      `q/${HEX}/640.avif`,
      `p/${HEX}/avif`,
      `p/${HEX}/12345.avif`,
    ])
      expect(await insert('media_variant', v({ object_key: bad })), bad).toBe(CHECK);
    await p.owner.query(
      'INSERT INTO media_variant (media_id, format, width, object_key, bytes) VALUES ($1, $2, $3, $4, 1)',
      [id, 'webp', 320, `p/${HEX}/320.webp`],
    );
    expect(await insert('media_variant', v({ format: 'webp', width: 320, object_key: `p/${key()}/320.webp` }))).toBe(
      UNIQUE,
    );
    expect(await insert('media_variant', v({ format: 'avif', width: 320, object_key: `p/${HEX}/320.webp` }))).toBe(
      UNIQUE,
    );
  });
});

describe('blocked_hash', () => {
  it('checks the hash and the reason, and the hash is the key', async () => {
    expect(await insert('blocked_hash', { sha256: SHA, reason: 'illegal' })).toBe('ok');
    expect(await insert('blocked_hash', { sha256: Buffer.alloc(3), reason: 'illegal' })).toBe(CHECK);
    expect(await insert('blocked_hash', { sha256: SHA, reason: 'Bad Reason' })).toBe(CHECK);
    expect(await insert('blocked_hash', { sha256: SHA, reason: 'x', moderation_action_id: crypto.randomUUID() })).toBe(
      'ok',
    );
    await p.owner.query("INSERT INTO blocked_hash (sha256, reason) VALUES ($1, 'x')", [SHA]);
    expect(await insert('blocked_hash', { sha256: SHA, reason: 'y' })).toBe(UNIQUE);
  });
});

describe('museum_image', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    museum_id: museumId,
    file: 'Rijksmuseum.jpg',
    sha1: 'a'.repeat(40),
    licence: 'cc-by-sa-4.0',
    attribution: 'Jane Doe',
    public_key: key(),
    width: 1200,
    height: 800,
    widths: [320, 640, 1200],
    state: 'active',
    ...extra,
  });
  const arr = (a: unknown[]) => a; // pg turns a JS array into an array literal

  it('takes an active row, a hidden row and a skipped row', async () => {
    expect(await insert('museum_image', active())).toBe('ok');
    expect(await insert('museum_image', active({ licence: 'cc0' }))).toBe('ok');
    expect(await insert('museum_image', active({ licence: 'cc-by-3.0-nl' }))).toBe('ok');
    expect(await insert('museum_image', { museum_id: museumId, file: 'X.jpg', state: 'hidden' })).toBe('ok');
    expect(
      await insert('museum_image', { museum_id: museumId, file: 'X.jpg', state: 'skipped', skip_code: 'no_licence' }),
    ).toBe('ok');
  });

  it.each([
    ['file with a slash', { file: 'a/b.jpg' }],
    ['file empty', { file: '' }],
    ['sha1 length', { sha1: 'abc' }],
    ['licence unknown', { licence: 'all-rights-reserved' }],
    ['licence version', { licence: 'cc-by-5.0' }],
    ['attribution empty', { attribution: '' }],
    ['attribution 201', { attribution: 'x'.repeat(201) }],
    ['attribution control', { attribution: 'a\u0007b' }],
    ['public_key', { public_key: 'nothex' }],
    ['width 0', { width: 0 }],
    ['widths empty', { widths: arr([]) }],
    ['widths five', { widths: arr([1, 2, 3, 4, 5]) }],
    ['widths over 2000', { widths: arr([2001]) }],
    ['widths zero', { widths: arr([0]) }],
    ['widths null element', { widths: '{320,NULL}' }],
    ['widths two-dimensional', { widths: '{{1,2},{3,4}}' }],
    ['state', { state: 'gone' }],
    ['skip_code digits', { skip_code: 'x1' }],
    ['active without sha1', { sha1: null }],
    ['active without licence', { licence: null }],
    ['active without public_key', { public_key: null }],
    ['active without width', { width: null }],
    ['active without height', { height: null }],
    ['active without widths', { widths: null }],
    ['skipped without skip_code', { state: 'skipped' }],
  ])('refuses %s', async (_n, extra) => {
    expect(await insert('museum_image', active(extra))).toBe(CHECK);
  });

  it('is one row per museum and the public_key is unique', async () => {
    const m2 = (await p.visible(2)).id;
    const m3 = (await p.visible(3)).id;
    await p.owner.query("INSERT INTO museum_image (museum_id, file, state) VALUES ($1, 'A.jpg', 'hidden')", [m2]);
    expect(await insert('museum_image', { museum_id: m2, file: 'B.jpg', state: 'hidden' })).toBe(UNIQUE);
    await p.owner.query(
      "INSERT INTO museum_image (museum_id, file, state, public_key) VALUES ($1, 'A.jpg', 'hidden', $2)",
      [m3, HEX.replace(/a/g, 'b')],
    );
    expect(
      await insert('museum_image', { museum_id: museumId, file: 'C.jpg', state: 'hidden', public_key: 'b'.repeat(32) }),
    ).toBe(UNIQUE);
  });
});
