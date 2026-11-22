import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { HttpResponse, http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { R2Client, R2Error } from '../../src/media/r2.ts';

// The R2 client against the MinIO stand-in, which speaks the S3 API that R2 speaks (A§18). Needs:
//
//   MJK_TEST_MINIO_URL  the stand-in's endpoint, e.g. http://127.0.0.1:59000
//   MJK_TEST_MINIO_ACCESS_KEY, MJK_TEST_MINIO_SECRET_KEY  its root credentials
//
// Skipped locally when MJK_TEST_MINIO_URL is unset, a failure under CI. MinIO wants a real region.

const minioUrl = process.env.MJK_TEST_MINIO_URL ?? '';
const MIB = 1024 * 1024;

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('the R2 client on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  describe('the R2 client on the MinIO stand-in', () => {
    const origin = new URL(minioUrl).origin;
    const accessKeyId = process.env.MJK_TEST_MINIO_ACCESS_KEY ?? '';
    const secretAccessKey = process.env.MJK_TEST_MINIO_SECRET_KEY ?? '';
    const bucket = `mjk-r2-${process.pid}-${randomBytes(3).toString('hex')}`;
    const keys = new Set<string>();
    const meta = { contentType: 'application/json', cacheControl: 'public, max-age=60' };
    let c: R2Client;

    // msw fails any request without a handler; these go to the real stand-in.
    const real = () => server.use(http.all(`${origin}/*`, () => passthrough()));
    const tempFile = (bytes: Uint8Array) => {
      const path = join(mkdtempSync(join(tmpdir(), 'mjk-r2-it-')), 'f.bin');
      writeFileSync(path, bytes);
      return path;
    };
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    const unfinished = async () => {
      const res = await c.send({ method: 'GET', query: { uploads: '' } });
      expect(res.status).toBe(200);
      return [...text(res.body).matchAll(/<Upload>.*?<Key>([^<]*)<\/Key>.*?<\/Upload>/gs)].map((m) => m[1]);
    };

    beforeAll(async () => {
      if (accessKeyId === '' || secretAccessKey === '') {
        throw new Error('MJK_TEST_MINIO_ACCESS_KEY and _SECRET_KEY are needed');
      }
      c = new R2Client({
        endpoint: minioUrl,
        bucket,
        region: 'us-east-1',
        credentials: { accessKeyId, secretAccessKey },
        timeoutMs: 30_000,
      });
      real();
      // CreateBucket, the e2e seed's call.
      expect((await c.send({ method: 'PUT' })).status).toBe(200);
    });

    beforeEach(real);

    afterAll(async () => {
      if (c === undefined) return;
      real();
      for (const key of keys) await c.delete(key);
      await c.send({ method: 'DELETE' });
    });

    it('puts, gets, heads and deletes, with Content-Type and Cache-Control read back', async () => {
      const key = 'tiles/current.json';
      keys.add(key);
      const body = '{"file":"tiles/nl-20261101.pmtiles"}';
      await c.put(key, body, meta);
      expect(text((await c.get(key, { maxBytes: 1024 })) ?? new Uint8Array())).toBe(body);
      const head = await c.head(key);
      expect(head?.size).toBe(Buffer.byteLength(body));
      expect(head?.etag).toMatch(/^"[0-9a-f]{32}"$/);
      const raw = await c.send({ method: 'HEAD', key });
      expect(raw.headers.get('content-type')).toBe('application/json');
      expect(raw.headers.get('cache-control')).toBe('public, max-age=60');
      await expect(c.get(key, { maxBytes: 10 })).rejects.toMatchObject({ code: 'store_too_large' });
      await c.delete(key);
      expect(await c.get(key, { maxBytes: 1024 })).toBeNull();
      expect(await c.head(key)).toBeNull();
      await c.delete(key);
    });

    it('answers null for a key that was never there', async () => {
      expect(await c.get('nope/missing.bin', { maxBytes: 10 })).toBeNull();
      expect(await c.head('nope/missing.bin')).toBeNull();
    });

    it('uploads an 11 MiB file in 5 MiB parts and reads back the exact bytes', async () => {
      const key = 'tiles/nl-test.pmtiles';
      keys.add(key);
      const bytes = randomBytes(11 * MIB);
      await c.putFile(key, tempFile(bytes), { ...meta, contentType: 'application/vnd.pmtiles', partSize: 5 * MIB });
      const head = await c.head(key);
      expect(head?.size).toBe(11 * MIB);
      // A multipart ETag names its part count.
      expect(head?.etag).toMatch(/-3"$/);
      const back = await c.get(key, { maxBytes: 12 * MIB });
      expect(back !== null && Buffer.from(back).equals(bytes)).toBe(true);
      const raw = await c.send({ method: 'HEAD', key });
      expect(raw.headers.get('content-type')).toBe('application/vnd.pmtiles');
      expect(raw.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await unfinished()).toEqual([]);
    });

    it('leaves no unfinished multipart upload when a part fails', async () => {
      // The control: an upload that nobody aborts is listed.
      const created = await c.send({ method: 'POST', key: 'control', query: { uploads: '' } });
      const id = /<UploadId>([^<]+)<\/UploadId>/.exec(text(created.body))?.[1] ?? '';
      expect(await unfinished()).toEqual(['control']);
      expect((await c.send({ method: 'DELETE', key: 'control', query: { uploadId: id } })).status).toBe(204);
      expect(await unfinished()).toEqual([]);

      // Part 2 fails before it reaches the stand-in; everything else is real.
      server.use(
        http.put(`${origin}/*`, ({ request }) =>
          new URL(request.url).searchParams.get('partNumber') === '2'
            ? new HttpResponse(null, { status: 500 })
            : passthrough(),
        ),
      );
      const key = 'tiles/nl-broken.pmtiles';
      const err = await c.putFile(key, tempFile(randomBytes(11 * MIB)), { ...meta, partSize: 5 * MIB }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(R2Error);
      expect(err).toMatchObject({ code: 'store_unavailable', status: 500 });
      expect(await unfinished()).toEqual([]);
      expect(await c.head(key)).toBeNull();
    });

    it('is denied with a wrong secret, and the error holds neither key', async () => {
      const wrong = `${secretAccessKey}x`;
      const bad = new R2Client({
        endpoint: minioUrl,
        bucket,
        region: 'us-east-1',
        credentials: { accessKeyId, secretAccessKey: wrong },
      });
      const err = await bad.put('denied.json', '{}', meta).then(
        () => undefined,
        (e: unknown) => e as R2Error,
      );
      expect(err).toMatchObject({ code: 'store_denied', status: 403, s3Code: 'SignatureDoesNotMatch' });
      for (const t of [String(err), JSON.stringify(err), err?.stack ?? '', inspect(err), inspect(bad)]) {
        expect(t).not.toContain(accessKeyId);
        expect(t).not.toContain(wrong);
        expect(t).not.toContain('Signature=');
      }
    });
  });
}
