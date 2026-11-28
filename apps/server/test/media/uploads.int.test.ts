import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { CHUNK_BYTES } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jpeg, openUploads, sha256Hex, type UploadsFixture, writeGuard } from './fixtures.ts';

// P3b criteria 1, 4, 5 (the api parts) and 6: the chunked upload (A§12, A§14). Every check runs before a byte
// is stored; a refused chunk writes nothing; a refused `complete` leaves no file and no job.

/** A well-formed id that no upload has. */
const NO_UPLOAD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

let f: UploadsFixture;
let museumId: string;

beforeAll(async () => {
  f = await openUploads();
  museumId = (await f.p.visible(0)).id;
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const member = async () => {
  const u = await f.p.newMember();
  return { ...u, token: await f.t.signIn(u.id) };
};

const mediaRow = async (id: string) =>
  (
    await f.p.owner.query<{
      state: string;
      error_code: string | null;
      consents_at: Date | null;
      sha256: Buffer | null;
    }>('SELECT state, error_code, consents_at, sha256 FROM media WHERE id = $1', [id])
  ).rows[0];

const jobsFor = async (id: string) =>
  (await f.p.owner.query<{ kind: string }>(`SELECT kind FROM job WHERE payload->>'media_id' = $1`, [id])).rows.map(
    (r) => r.kind,
  );

const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('POST /uploads', () => {
  it('creates an uploading row with the consents, an address log, and a 0700 directory', async () => {
    const m = await member();
    const r = await f.create(m.token, { museumId, size: CHUNK_BYTES + 1 });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = (await r.json()) as { id: string; chunk_size: number; chunk_count: number };
    expect(body).toEqual({ id: body.id, chunk_size: CHUNK_BYTES, chunk_count: 2 });
    const row = await mediaRow(body.id);
    expect(row?.state).toBe('uploading');
    expect(row?.consents_at).toBeInstanceOf(Date);
    const ip = await f.p.owner.query(`SELECT 1 FROM content_ip_log WHERE target_kind = 'media' AND target_id = $1`, [
      body.id,
    ]);
    expect(ip.rowCount).toBe(1);
    const dir = await stat(join(f.root, body.id));
    expect(dir.mode & 0o777).toBe(0o700);
    expect((await stat(join(f.root, body.id, 'upload'))).size).toBe(0);
  });

  it('without the three consents → 422 ["consents"], nothing stored', async () => {
    const m = await member();
    for (const consents of [
      { own_photo: false, no_people: true, no_artwork: true },
      { own_photo: true, no_people: false, no_artwork: true },
      { own_photo: true, no_people: true, no_artwork: false },
    ]) {
      const r = await f.create(m.token, { museumId, size: 1000, consents });
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields: ['consents'] });
    }
    const missing = await f.t.call('/uploads', {
      token: m.token,
      body: { kind: 'photo', size: 1000, type: 'image/jpeg', museum_id: museumId },
    });
    expect(missing.status).toBe(400);
    const rows = await f.p.owner.query('SELECT 1 FROM media WHERE user_id = $1', [m.id]);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses another type (415), an oversize photo (422) and a museum or review that is not one', async () => {
    const m = await member();
    for (const type of ['image/gif', 'image/heic', 'image/svg+xml', 'text/html', 'image/apng'])
      expect((await f.create(m.token, { museumId, size: 1000, type })).status).toBe(415);
    const big = await f.create(m.token, { museumId, size: 25 * 1024 * 1024 + 1 });
    expect(big.status).toBe(422);
    expect(await big.json()).toEqual({ error: 'invalid', fields: ['size'] });
    const hidden = await f.create(m.token, { museumId: (await f.p.hidden()).id, size: 1000 });
    expect(await hidden.json()).toEqual({ error: 'invalid', fields: ['museum_id'] });
    const unknown = await f.create(m.token, { museumId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', size: 1000 });
    expect(await unknown.json()).toEqual({ error: 'invalid', fields: ['museum_id'] });
    const notOwn = await f.create(m.token, {
      museumId,
      size: 1000,
      reviewId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(await notOwn.json()).toEqual({ error: 'invalid', fields: ['review_id'] });
  });

  it('needs a member on the current terms', async () => {
    expect((await f.create('nope', { museumId, size: 1000 })).status).toBe(401);
    const m = await member();
    await f.p.owner.query(`UPDATE app_user SET terms_version = 'old' WHERE id = $1`, [m.id]);
    const r = await f.create(m.token, { museumId, size: 1000 });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'terms_required' });
  });

  it('a 4th open upload → 429 with Retry-After', async () => {
    const m = await member();
    for (let i = 0; i < 3; i++) expect((await f.create(m.token, { museumId, size: 1000 })).status).toBe(201);
    const r = await f.create(m.token, { museumId, size: 1000 });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('the disk guard: under 10 % free, a stale or missing file → 503 unavailable, nothing stored', async () => {
    const m = await member();
    try {
      for (const write of [
        () => writeGuard(f.guard, 9),
        () => writeGuard(f.guard, 50, new Date(Date.now() - 31 * 60 * 1000)),
        () => writeGuard(f.guard, 50, new Date(Date.now() + 60 * 60 * 1000)),
        async () => {
          const { rm } = await import('node:fs/promises');
          await rm(join(f.guard, 'disk'));
        },
      ]) {
        await write();
        const r = await f.create(m.token, { museumId, size: 1000 });
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: 'unavailable' });
      }
      expect((await f.p.owner.query('SELECT 1 FROM media WHERE user_id = $1', [m.id])).rowCount).toBe(0);
    } finally {
      await writeGuard(f.guard, 50);
    }
    expect((await f.create(m.token, { museumId, size: 1000 })).status).toBe(201);
  });
});

describe('PUT /uploads/:id/chunks/:n', () => {
  it('refuses a bad index, a wrong length, a wrong type and another member, writing nothing', async () => {
    const m = await member();
    const made = (await (await f.create(m.token, { museumId, size: CHUNK_BYTES + 10 })).json()) as { id: string };
    const file = join(f.root, made.id, 'upload');
    const ten = Buffer.alloc(10, 1);
    for (const n of [2, 3, 99]) {
      const r = await f.put(m.token, made.id, n, ten);
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields: ['n'] });
    }
    // Not the chunk route's shape: only that exact path takes application/octet-stream.
    expect((await f.put(m.token, made.id, 'x', ten)).status).toBe(415);
    // chunk 0 must be exactly 8 MiB, chunk 1 exactly 10 bytes
    const short = await f.put(m.token, made.id, 0, ten);
    expect(await short.json()).toEqual({ error: 'invalid', fields: ['length'] });
    const long = await f.put(m.token, made.id, 1, Buffer.alloc(11, 1));
    expect(await long.json()).toEqual({ error: 'invalid', fields: ['length'] });
    expect((await f.put(m.token, made.id, 1, ten, { type: 'application/json' })).status).toBe(415);
    expect((await f.put(m.token, made.id, 1, ten, { type: 'image/jpeg' })).status).toBe(415);
    const other = await member();
    expect((await f.put(other.token, made.id, 1, ten)).status).toBe(404);
    expect((await f.put(m.token, NO_UPLOAD, 1, ten)).status).toBe(404);
    expect((await stat(file)).size).toBe(0);
    const chunks = await f.p.owner.query('SELECT 1 FROM media_chunk WHERE media_id = $1', [made.id]);
    expect(chunks.rowCount).toBe(0);
  });

  it('a chunk over 8 MiB → 413 before the route', async () => {
    const m = await member();
    const made = (await (await f.create(m.token, { museumId, size: 2 * CHUNK_BYTES })).json()) as { id: string };
    const r = await f.put(m.token, made.id, 0, Buffer.alloc(16), { length: CHUNK_BYTES + 1 });
    expect(r.status).toBe(413);
    expect((await stat(join(f.root, made.id, 'upload'))).size).toBe(0);
  });

  it('accepts an identical re-send and refuses a different one, which leaves the chunk unreceived', async () => {
    const m = await member();
    const bytes = await jpeg(1000);
    const made = (await (await f.create(m.token, { museumId, size: bytes.length })).json()) as { id: string };
    expect((await f.put(m.token, made.id, 0, bytes)).status).toBe(204);
    expect((await f.put(m.token, made.id, 0, bytes)).status).toBe(204);
    const other = Buffer.from(bytes);
    other[other.length - 1] = (other.at(-1) ?? 0) ^ 0xff;
    const r = await f.put(m.token, made.id, 0, other);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['chunk'] });
    const c = await f.complete(m.token, made.id, sha256Hex(bytes));
    expect(c.status).toBe(422);
    expect(await c.json()).toEqual({ error: 'invalid', fields: ['chunks'] });
    expect((await mediaRow(made.id))?.state).toBe('uploading');
    expect((await f.put(m.token, made.id, 0, bytes)).status).toBe(204);
    expect((await f.complete(m.token, made.id, sha256Hex(bytes))).status).toBe(202);
  });

  it('a body that ends short is refused and the chunk stays unreceived', async () => {
    const m = await member();
    const made = (await (await f.create(m.token, { museumId, size: 1000 })).json()) as { id: string };
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(400));
        ctl.close();
      },
    });
    const r = await f.raw(`/uploads/${made.id}/chunks/0`, {
      method: 'PUT',
      token: m.token,
      body: stream,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' },
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['body'] });
    expect((await f.p.owner.query('SELECT 1 FROM media_chunk WHERE media_id = $1', [made.id])).rowCount).toBe(0);
    expect((await stat(join(f.root, made.id, 'upload'))).size).toBeLessThanOrEqual(1000);
  });

  it('a body that runs past its Content-Length is refused and writes nothing past the chunk', async () => {
    const m = await member();
    const made = (await (await f.create(m.token, { museumId, size: 1000 })).json()) as { id: string };
    // Node's HTTP framing cannot deliver a long body; app.request() can, as a stream with no framing (M3).
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(900));
        ctl.enqueue(new Uint8Array(600));
        ctl.close();
      },
    });
    const r = await f.raw(`/uploads/${made.id}/chunks/0`, {
      method: 'PUT',
      token: m.token,
      body: stream,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' },
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['body'] });
    expect((await f.p.owner.query('SELECT 1 FROM media_chunk WHERE media_id = $1', [made.id])).rowCount).toBe(0);
    expect((await stat(join(f.root, made.id, 'upload'))).size).toBeLessThanOrEqual(1000);
  });
});

describe('POST /uploads/:id/complete', () => {
  it('a multi-chunk JPEG → 202, quarantined with its sha256, one media_process job, no chunk rows', async () => {
    const m = await member();
    const bytes = await jpeg(CHUNK_BYTES + 12_345);
    const { id, done } = await f.upload(m.token, museumId, bytes);
    expect(done.status).toBe(202);
    expect(await done.json()).toEqual({ id, state: 'quarantined', error_code: null, keys: [] });
    const row = await mediaRow(id);
    expect(row?.state).toBe('quarantined');
    expect(row?.sha256?.toString('hex')).toBe(sha256Hex(bytes));
    expect(await jobsFor(id)).toEqual(['media_process']);
    expect((await f.p.owner.query('SELECT 1 FROM media_chunk WHERE media_id = $1', [id])).rowCount).toBe(0);
    expect((await stat(join(f.root, id, 'upload'))).size).toBe(bytes.length);
    const status = await f.t.call(`/uploads/${id}`, { token: m.token });
    expect(await status.json()).toEqual({ id, state: 'quarantined', error_code: null, keys: [] });
    expect(
      (await f.t.call(`/uploads/${id}/complete`, { token: m.token, body: { sha256: sha256Hex(bytes) } })).status,
    ).toBe(409);
  });

  it('a missing chunk → 422, the upload stays open', async () => {
    const m = await member();
    const bytes = await jpeg(CHUNK_BYTES + 100);
    const made = (await (await f.create(m.token, { museumId, size: bytes.length })).json()) as { id: string };
    expect((await f.put(m.token, made.id, 1, bytes.subarray(CHUNK_BYTES))).status).toBe(204);
    const r = await f.complete(m.token, made.id, sha256Hex(bytes));
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['chunks'] });
    expect((await mediaRow(made.id))?.state).toBe('uploading');
  });

  it('a sha256 mismatch → 422, the upload failed and its file gone, no job', async () => {
    const m = await member();
    const bytes = await jpeg();
    const made = (await (await f.create(m.token, { museumId, size: bytes.length })).json()) as { id: string };
    expect((await f.put(m.token, made.id, 0, bytes)).status).toBe(204);
    const r = await f.complete(m.token, made.id, sha256Hex(Buffer.from('other')));
    expect(await r.json()).toEqual({ error: 'invalid', fields: ['sha256'] });
    expect(await mediaRow(made.id)).toMatchObject({ state: 'failed', error_code: 'upload_hash_mismatch' });
    expect(await exists(join(f.root, made.id))).toBe(false);
    expect(await jobsFor(made.id)).toEqual([]);
  });

  /** The PNG with an `acTL` chunk (one frame, endless) right after IHDR: an animated PNG. */
  const apngOf = (png: Buffer): Buffer => {
    const data = Buffer.alloc(8);
    data.writeUInt32BE(1, 0); // num_frames
    const body = Buffer.concat([Buffer.from('acTL', 'latin1'), data]);
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(data.length, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(body), body.length + 4);
    const afterIhdr = 8 + 25; // the signature, then IHDR (length, type, 13 bytes, CRC)
    return Buffer.concat([png.subarray(0, afterIhdr), chunk, png.subarray(afterIhdr)]);
  };

  it('magic bytes that are not the declared allowed image → 415, nothing reaches the worker', async () => {
    const m = await member();
    const png = await (await import('sharp'))
      .default({
        create: { width: 8, height: 8, channels: 3, background: '#000' },
      })
      .png()
      .toBuffer();
    const cases: [Buffer, string][] = [
      [Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/jpeg'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png'],
      [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), 'image/webp'],
      [png, 'image/jpeg'],
      // An APNG declared as a PNG (owner Q7: refused): an acTL chunk before the first IDAT makes file-type say apng.
      [apngOf(png), 'image/png'],
    ];
    for (const [bytes, type] of cases) {
      const { id, done } = await f.upload(m.token, museumId, bytes, type);
      expect(done.status).toBe(415);
      expect(await mediaRow(id)).toMatchObject({ state: 'failed', error_code: 'upload_type_mismatch' });
      expect(await jobsFor(id)).toEqual([]);
      expect(await exists(join(f.root, id))).toBe(false);
    }
  });
});

describe('DELETE /uploads/:id', () => {
  it('aborts an open upload; a finished one is a 409; another member’s a 404', async () => {
    const m = await member();
    const made = (await (await f.create(m.token, { museumId, size: 1000 })).json()) as { id: string };
    const other = await member();
    expect((await f.t.call(`/uploads/${made.id}`, { token: other.token, method: 'DELETE' })).status).toBe(404);
    expect((await f.t.call(`/uploads/${made.id}`, { token: m.token, method: 'DELETE' })).status).toBe(204);
    expect(await mediaRow(made.id)).toBeUndefined();
    expect(await exists(join(f.root, made.id))).toBe(false);
    const { id } = await f.upload(m.token, museumId, await jpeg());
    expect((await f.t.call(`/uploads/${id}`, { token: m.token, method: 'DELETE' })).status).toBe(409);
  });
});
