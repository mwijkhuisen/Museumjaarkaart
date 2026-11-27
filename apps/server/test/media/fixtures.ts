import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_BYTES } from '@mjk/contracts';
import sharp from 'sharp';
import { mountUploads } from '../../src/api/routes/uploads.ts';
import { SESSION_COOKIE } from '../../src/auth/session.ts';
import { meApp, SITE } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';

// P3b's upload fixture: the upload routes over meApp (session cookie, same-origin headers, a client address we
// choose) with a temp quarantine and a temp disk-guard directory, plus helpers for the chunked flow. Rows that no
// login may write freely (a backdated or pre-filled photo) are the owner's (p.owner, mjk_migrator).

export type UploadsFixture = Awaited<ReturnType<typeof openUploads>>;

/** The disk guard's file as mjk-tick writes it. */
export async function writeGuard(dir: string, pct: number, at: Date = new Date()): Promise<void> {
  const checked = at.toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
  await writeFile(join(dir, 'disk'), `free_pct=${pct}\nfree_bytes=1000\ntotal_bytes=2000\nchecked=${checked}\n`);
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A small real JPEG (sharp), optionally padded with random bytes after its end so it spans several chunks. */
export async function jpeg(padTo = 0): Promise<Buffer> {
  const img = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
  return padTo > img.length ? Buffer.concat([img, randomBytes(padTo - img.length)]) : img;
}

export async function openUploads(p?: PassportDb) {
  const db = p ?? (await openPassportDb());
  const root = await mkdtemp(join(tmpdir(), 'mjk-quarantine-'));
  const guard = await mkdtemp(join(tmpdir(), 'mjk-guard-'));
  await writeGuard(guard, 50);
  const t = meApp(db, mountUploads, { quarantineDir: root, guardDir: guard });

  /** A raw request with the session cookie and same-origin headers. */
  const raw = (
    path: string,
    o: {
      method?: string;
      token?: string;
      body?: Uint8Array | ReadableStream<Uint8Array> | string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    t.app.request(`http://localhost/api/v1${path}`, {
      method: o.method ?? 'GET',
      ...(o.body === undefined ? {} : { body: o.body, duplex: 'half' }),
      headers: {
        host: SITE.domain,
        'Sec-Fetch-Site': 'same-origin',
        ...(o.token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${o.token}` }),
        ...o.headers,
      },
    } as RequestInit);

  const consents = { own_photo: true, no_people: true, no_artwork: true };

  /** POST /uploads for `bytes` (or a size) as `type`. */
  const create = (
    token: string,
    o: { museumId: string; size: number; type?: string; reviewId?: string; consents?: object },
  ) =>
    t.call('/uploads', {
      token,
      body: {
        kind: 'photo',
        size: o.size,
        type: o.type ?? 'image/jpeg',
        museum_id: o.museumId,
        ...(o.reviewId === undefined ? {} : { review_id: o.reviewId }),
        consents: o.consents ?? consents,
      },
    });

  /** PUT one chunk; `length` overrides the Content-Length header, `type` the Content-Type. */
  const put = (
    token: string,
    id: string,
    n: number | string,
    bytes: Uint8Array,
    o: { length?: number; type?: string } = {},
  ) =>
    raw(`/uploads/${id}/chunks/${n}`, {
      method: 'PUT',
      token,
      body: bytes,
      headers: {
        'Content-Type': o.type ?? 'application/octet-stream',
        'Content-Length': String(o.length ?? bytes.byteLength),
      },
    });

  const complete = (token: string, id: string, sha256: string) =>
    t.call(`/uploads/${id}/complete`, { token, body: { sha256 } });

  /** The whole flow for `bytes`: create, every chunk, complete. Returns the id and the complete answer. */
  async function upload(token: string, museumId: string, bytes: Buffer, type = 'image/jpeg') {
    const made = await create(token, { museumId, size: bytes.length, type });
    if (made.status !== 201) throw new Error(`create: ${made.status} ${await made.text()}`);
    const { id, chunk_count } = (await made.json()) as { id: string; chunk_count: number };
    for (let n = 0; n < chunk_count; n++) {
      const r = await put(token, id, n, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));
      if (r.status !== 204) throw new Error(`chunk ${n}: ${r.status} ${await r.text()}`);
    }
    return { id, done: await complete(token, id, sha256Hex(bytes)) };
  }

  const close = async () => {
    await rm(root, { recursive: true, force: true });
    await rm(guard, { recursive: true, force: true });
    if (p === undefined) await db.close();
  };
  return { p: db, t, root, guard, raw, create, put, complete, upload, consents, close };
}
