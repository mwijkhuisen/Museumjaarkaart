import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { R2Client } from '../../src/media/r2.ts';
import { publishTiles, readCurrent, rollbackTiles } from '../../src/tiles/publish.ts';

// publishTiles and rollbackTiles against the MinIO stand-in (the S3 API that R2 speaks; A§18), the code the CI
// e2e stack's seed runs. Needs MJK_TEST_MINIO_URL, MJK_TEST_MINIO_ACCESS_KEY and MJK_TEST_MINIO_SECRET_KEY;
// skipped locally when the URL is unset, a failure under CI (as r2.int.test.ts).

const minioUrl = process.env.MJK_TEST_MINIO_URL ?? '';

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('publishTiles on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  describe('publishTiles on the MinIO stand-in', () => {
    const origin = new URL(minioUrl).origin;
    const bucket = `mjk-tiles-${process.pid}-${randomBytes(3).toString('hex')}`;
    const A = 'nl-20260801.pmtiles';
    const B = 'nl-20261101.pmtiles';
    const C = 'nl-20270201.pmtiles';
    const key = (file: string) => `tiles/${file}`;
    let c: R2Client;
    const files: Record<string, { path: string; bytes: Buffer }> = {};

    // msw fails any request without a handler; these go to the real stand-in.
    const real = () => server.use(http.all(`${origin}/*`, () => passthrough()));

    beforeAll(async () => {
      const accessKeyId = process.env.MJK_TEST_MINIO_ACCESS_KEY ?? '';
      const secretAccessKey = process.env.MJK_TEST_MINIO_SECRET_KEY ?? '';
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
      expect((await c.send({ method: 'PUT' })).status).toBe(200);
      // Three different files, so the bytes read back say which one is which.
      const dir = mkdtempSync(join(tmpdir(), 'mjk-tiles-it-'));
      const fixture = readFileSync(join(import.meta.dirname, '../../../web/e2e/tiles/fixture.pmtiles'));
      for (const [file, extra] of [
        [A, 1],
        [B, 2],
        [C, 3],
      ] as const) {
        const bytes = Buffer.concat([fixture, randomBytes(extra * 1000)]);
        const path = join(dir, file);
        writeFileSync(path, bytes);
        files[file] = { path, bytes };
      }
    });

    beforeEach(real);

    afterAll(async () => {
      if (c === undefined) return;
      real();
      for (const k of [key(A), key(B), key(C), 'tiles/current.json']) await c.delete(k);
      await c.send({ method: 'DELETE' });
    });

    const read = async (file: string) => {
      const raw = await c.send({ method: 'HEAD', key: key(file) });
      if (raw.status === 404) return null;
      const body = await c.get(key(file), { maxBytes: 1024 * 1024 });
      return {
        body: Buffer.from(body ?? []),
        type: raw.headers.get('content-type'),
        cache: raw.headers.get('cache-control'),
      };
    };
    const publish = (file: string) => publishTiles(c, (files[file] as { path: string }).path, file);

    it('publishes twice and a third time, keeps the previous file and deletes the one two back', async () => {
      expect(await readCurrent(c)).toBeNull();
      expect(await publish(A)).toEqual({ file: A, previous: null });
      expect(await publish(B)).toEqual({ file: B, previous: A });

      const b = await read(B);
      expect(b?.body.equals((files[B] as { bytes: Buffer }).bytes)).toBe(true);
      expect(b?.type).toBe('application/vnd.pmtiles');
      expect(b?.cache).toBe('public, max-age=31536000, immutable');
      expect((await read(A))?.body.equals((files[A] as { bytes: Buffer }).bytes)).toBe(true);

      const current = await c.send({ method: 'GET', key: 'tiles/current.json' });
      expect(JSON.parse(new TextDecoder().decode(current.body))).toEqual({ file: B, previous: A });
      expect(current.headers.get('content-type')).toBe('application/json');
      expect(current.headers.get('cache-control')).toBe('public, max-age=300');

      expect(await publish(C)).toEqual({ file: C, previous: B });
      expect(await read(A)).toBeNull();
      expect((await read(B))?.body.equals((files[B] as { bytes: Buffer }).bytes)).toBe(true);
      expect((await read(C))?.body.equals((files[C] as { bytes: Buffer }).bytes)).toBe(true);
      expect(await readCurrent(c)).toEqual({ file: C, previous: B });
    });

    it('rolls back to the previous file, and the next refresh deletes the file it rolled away from', async () => {
      expect(await rollbackTiles(c)).toEqual({ file: B, previous: C });
      expect(await readCurrent(c)).toEqual({ file: B, previous: C });
      const current = await c.send({ method: 'HEAD', key: 'tiles/current.json' });
      expect(current.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await read(C)).not.toBeNull();

      // A refresh that builds A again (it was deleted): current is B, previous C; C goes, A comes.
      expect(await publish(A)).toEqual({ file: A, previous: B });
      expect(await read(C)).toBeNull();
      expect(await readCurrent(c)).toEqual({ file: A, previous: B });
    });
  });
}
