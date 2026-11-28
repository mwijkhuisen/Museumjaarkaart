import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKETS, hit, userKey } from '../../src/auth/limiter.ts';
import { jpeg, openUploads, sha256Hex, type UploadsFixture } from './fixtures.ts';

// P3b criterion 7 and the site-wide part of 5 (A§12): every quota is refused at create, before any chunk is
// stored; a blocked hash is refused at `complete` and audit-logged. Pre-filled photos are the owner's rows.

let f: UploadsFixture;

beforeAll(async () => {
  f = await openUploads();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const MiB = 1024 * 1024;
const member = async () => {
  const u = await f.p.newMember();
  return { ...u, token: await f.t.signIn(u.id) };
};

/** Owner-inserted photos of a member: `quarantined` (any live state counts), with a sha256 as the CHECK wants. */
async function prefill(userId: string, museumId: string, n: number, size = 1000, state = 'quarantined') {
  for (let i = 0; i < n; i++) {
    await f.p.owner.query(
      `INSERT INTO media (user_id, museum_id, type, state, declared_size, chunk_count, sha256, consents_at)
       VALUES ($1, $2, 'image/jpeg', $3, $4, ($4 + 8388607) / 8388608, sha256(gen_random_uuid()::text::bytea), now())`,
      [userId, museumId, state, size],
    );
  }
}

describe('quotas at create', () => {
  it('the 11th photo of a museum → 422 ["photos"]; failed or removed ones do not count', async () => {
    const m = await member();
    const museum = (await f.p.visible(1)).id;
    await prefill(m.id, museum, 9);
    await prefill(m.id, museum, 3, 1000, 'failed');
    expect((await f.create(m.token, { museumId: museum, size: 1000 })).status).toBe(201);
    const r = await f.create(m.token, { museumId: museum, size: 1000 });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['photos'] });
    // another museum is fine
    expect((await f.create(m.token, { museumId: (await f.p.visible(2)).id, size: 1000 })).status).toBe(201);
  });

  it('the 31st photo in a day → 429 with Retry-After', async () => {
    const m = await member();
    const museum = (await f.p.visible(3)).id;
    for (let i = 0; i < 30; i++) await hit(f.p.db, BUCKETS.photoUserDay, userKey(f.t.keys, 'photo', m.id));
    const r = await f.create(m.token, { museumId: museum, size: 1000 });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await f.p.owner.query('SELECT 1 FROM media WHERE user_id = $1', [m.id])).rowCount).toBe(0);
  });

  it('a refused create counts for nothing against the day', async () => {
    const m = await member();
    const museum = (await f.p.visible(4)).id;
    for (let i = 0; i < 29; i++) await hit(f.p.db, BUCKETS.photoUserDay, userKey(f.t.keys, 'photo', m.id));
    expect((await f.create(m.token, { museumId: museum, size: 1000, type: 'image/gif' })).status).toBe(415);
    expect((await f.create(m.token, { museumId: museum, size: 1000 })).status).toBe(201);
    expect((await f.create(m.token, { museumId: museum, size: 1000 })).status).toBe(429);
  });

  it('a photo that crosses 1 GiB → 422 ["size"], before anything is stored', async () => {
    const m = await member();
    // 40 × 25 MiB over four museums (10 each), then 23 MiB: 1,023 MiB in all.
    for (let i = 0; i < 4; i++) await prefill(m.id, (await f.p.visible(10 + i)).id, 10, 25 * MiB);
    await prefill(m.id, (await f.p.visible(14)).id, 1, 23 * MiB);
    const museum = (await f.p.visible(15)).id;
    const r = await f.create(m.token, { museumId: museum, size: 2 * MiB });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['size'] });
    expect((await f.create(m.token, { museumId: museum, size: MiB })).status).toBe(201);
  });

  it('2 GiB declared across every open upload → 503 unavailable', async () => {
    const other = await member();
    const museums = await Promise.all([20, 21, 22, 23, 24, 25, 26, 27, 28].map((n) => f.p.visible(n)));
    // 82 open uploads of 25 MiB (2,050 MiB) by one member, as rows (the 3-open rule is the api's, not the table's).
    for (const [i, museum] of museums.entries())
      await prefill(other.id, museum.id, i < 1 ? 10 : 9, 25 * MiB, 'uploading');
    try {
      const m = await member();
      const r = await f.create(m.token, { museumId: (await f.p.visible(30)).id, size: 1000 });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'unavailable' });
    } finally {
      await f.p.owner.query(`DELETE FROM media WHERE user_id = $1`, [other.id]);
    }
  });
});

describe('blocked_hash at complete', () => {
  it('a file whose sha256 is blocked → 422 ["file"], failed, its file gone, no job, one audit row', async () => {
    const m = await member();
    const bytes = await jpeg(5000);
    await f.p.owner.query(`INSERT INTO blocked_hash (sha256, reason) VALUES ($1, 'csam')`, [
      Buffer.from(sha256Hex(bytes), 'hex'),
    ]);
    const { id, done } = await f.upload(m.token, (await f.p.visible(40)).id, bytes);
    expect(done.status).toBe(422);
    expect(await done.json()).toEqual({ error: 'invalid', fields: ['file'] });
    const row = await f.p.owner.query<{ state: string; error_code: string }>(
      'SELECT state, error_code FROM media WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ state: 'failed', error_code: 'upload_refused' });
    // The member's status poll learns nothing about the block list.
    const status = await f.raw(`/uploads/${id}`, { method: 'GET', token: m.token });
    expect(await status.json()).toMatchObject({ state: 'failed', error_code: 'upload_refused' });
    // The audit row names the member, so it outlives the failed photo's purge.
    const audit = await f.p.owner.query<{ action: string; actor_kind: string; detail: unknown }>(
      `SELECT action, actor_kind, detail FROM audit_log WHERE target_kind = 'user' AND target_id = $1`,
      [m.id],
    );
    expect(audit.rows).toEqual([{ action: 'media.blocked', actor_kind: 'system', detail: { media_id: id } }]);
    await f.p.owner.query(`DELETE FROM media WHERE id = $1`, [id]);
    expect((await f.p.owner.query(`SELECT 1 FROM audit_log WHERE target_id = $1`, [m.id])).rowCount).toBe(1);
    expect((await f.p.owner.query(`SELECT 1 FROM job WHERE payload->>'media_id' = $1`, [id])).rowCount).toBe(0);
    await expect(stat(join(f.root, id))).rejects.toThrow();
  });
});
