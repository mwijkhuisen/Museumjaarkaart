import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { R2Client } from '../../src/media/r2.ts';
import { parseCurrent, publishTiles, rollbackTiles } from '../../src/tiles/publish.ts';
import { fakeBucket } from './fake-r2.ts';

const FIXTURE = join(import.meta.dirname, '../../../web/e2e/tiles/fixture.pmtiles');
const BYTES = readFileSync(FIXTURE);
const client = () =>
  new R2Client({
    endpoint: 'https://r2.test',
    bucket: 'mjk-media',
    region: 'auto',
    credentials: { accessKeyId: 'AKIATESTKEY0001', secretAccessKey: 'test-secret-value-0001' },
  });
const A = 'nl-20260801.pmtiles';
const B = 'nl-20261101.pmtiles';
const C = 'nl-20270201.pmtiles';
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('parseCurrent', () => {
  const parse = (v: string) => parseCurrent(new TextEncoder().encode(v));
  it('reads exactly file and previous', () => {
    expect(parse(`{"file":"${A}","previous":null}`)).toEqual({ file: A, previous: null });
    expect(parse(`{"previous":"${A}","file":"${B}"}`)).toEqual({ file: B, previous: A });
  });
  it('refuses everything else with tiles_current_invalid', () => {
    for (const v of [
      '',
      '[]',
      'null',
      '{}',
      `{"file":"${A}"}`,
      `{"file":"${A}","previous":null,"extra":1}`,
      `{"file":"../${A}","previous":null}`,
      `{"file":"${A}","previous":"${A}"}`,
      `{"file":"${A}","previous":"x.pmtiles"}`,
      `{"file":"nl-2026080.pmtiles","previous":null}`,
      `{"file":1,"previous":null}`,
    ]) {
      expect(() => parse(v), v).toThrow(expect.objectContaining({ code: 'tiles_current_invalid', retry: false }));
    }
  });
});

describe('publishTiles', () => {
  it('uploads, checks the size, then flips current.json; nothing to delete on the first run', async () => {
    const r2 = fakeBucket();
    expect(await publishTiles(client(), FIXTURE, A)).toEqual({ file: A, previous: null });
    expect(r2.log).toEqual(['GET tiles/current.json', `PUT tiles/${A}`, `HEAD tiles/${A}`, 'PUT tiles/current.json']);
    const file = r2.objects.get(`tiles/${A}`);
    expect(Buffer.from(file?.body ?? []).equals(BYTES)).toBe(true);
    expect(file?.contentType).toBe('application/vnd.pmtiles');
    expect(file?.cacheControl).toBe('public, max-age=31536000, immutable');
    const current = r2.objects.get('tiles/current.json');
    expect(JSON.parse(text(current?.body ?? new Uint8Array()))).toEqual({ file: A, previous: null });
    expect(current?.contentType).toBe('application/json');
    expect(current?.cacheControl).toBe('public, max-age=300');
  });

  it('keeps the previous file, and deletes the file two back only after the flip', async () => {
    const r2 = fakeBucket();
    await publishTiles(client(), FIXTURE, A);
    await publishTiles(client(), FIXTURE, B);
    expect(r2.current()).toEqual({ file: B, previous: A });
    expect([...r2.objects.keys()].sort()).toEqual(['tiles/current.json', `tiles/${A}`, `tiles/${B}`]);
    r2.log.length = 0;
    await publishTiles(client(), FIXTURE, C);
    expect(r2.current()).toEqual({ file: C, previous: B });
    expect(r2.log).toEqual([
      'GET tiles/current.json',
      `PUT tiles/${C}`,
      `HEAD tiles/${C}`,
      'PUT tiles/current.json',
      `DELETE tiles/${A}`,
    ]);
    expect([...r2.objects.keys()].sort()).toEqual(['tiles/current.json', `tiles/${B}`, `tiles/${C}`]);
  });

  it('does not touch the bucket again for the current or the previous file', async () => {
    const r2 = fakeBucket();
    await publishTiles(client(), FIXTURE, A);
    await publishTiles(client(), FIXTURE, B);
    r2.log.length = 0;
    expect(await publishTiles(client(), FIXTURE, B)).toEqual({ file: B, previous: A });
    expect(await publishTiles(client(), FIXTURE, A)).toEqual({ file: B, previous: A });
    expect(r2.log).toEqual(['GET tiles/current.json', 'GET tiles/current.json']);
  });

  it('does not flip when the stored size differs, or when the upload fails', async () => {
    const r2 = fakeBucket();
    server.use(
      http.head(
        'https://r2.test/mjk-media/tiles/nl-20261101.pmtiles',
        () => new HttpResponse(null, { headers: { 'content-length': '5', etag: '"x"' } }),
      ),
    );
    expect(await code(publishTiles(client(), FIXTURE, B))).toBe('tiles_size_mismatch');
    expect(r2.objects.has('tiles/current.json')).toBe(false);
    server.use(
      http.put('https://r2.test/mjk-media/tiles/nl-20261101.pmtiles', () => new HttpResponse(null, { status: 503 })),
    );
    expect(await code(publishTiles(client(), FIXTURE, B))).toBe('store_unavailable');
    expect(r2.objects.has('tiles/current.json')).toBe(false);
  });

  it('refuses a name that is not ours and a current.json it cannot read', async () => {
    const r2 = fakeBucket();
    expect(await code(publishTiles(client(), FIXTURE, '../x.pmtiles'))).toBe('tiles_bad_file');
    r2.put('tiles/current.json', '{"file":"x"}');
    r2.log.length = 0;
    expect(await code(publishTiles(client(), FIXTURE, A))).toBe('tiles_current_invalid');
    expect(r2.log).toEqual(['GET tiles/current.json']);
  });

  it('a failed delete after the flip does not fail the publish', async () => {
    const r2 = fakeBucket();
    await publishTiles(client(), FIXTURE, A);
    await publishTiles(client(), FIXTURE, B);
    server.use(http.delete(`https://r2.test/mjk-media/tiles/${A}`, () => new HttpResponse(null, { status: 503 })));
    const { logger, lines } = memoryLogger('worker');
    expect(await publishTiles(client(), FIXTURE, C, { logger })).toEqual({ file: C, previous: B });
    expect(r2.current()).toEqual({ file: C, previous: B });
    expect(lines().map((l) => l.msg)).toEqual(['tiles_old_delete_failed']);
  });
});

describe('rollbackTiles', () => {
  it('swaps the two names and keeps both files', async () => {
    const r2 = fakeBucket();
    await publishTiles(client(), FIXTURE, A);
    await publishTiles(client(), FIXTURE, B);
    expect(await rollbackTiles(client())).toEqual({ file: A, previous: B });
    expect(r2.current()).toEqual({ file: A, previous: B });
    expect(r2.objects.has(`tiles/${A}`) && r2.objects.has(`tiles/${B}`)).toBe(true);
    // And a refresh after a rollback deletes the bad file only once the new one is current.
    await publishTiles(client(), FIXTURE, C);
    expect(r2.current()).toEqual({ file: C, previous: A });
    expect(r2.objects.has(`tiles/${B}`)).toBe(false);
  });

  it('fails tiles_no_previous without one, without current.json, or when the previous file is gone', async () => {
    const r2 = fakeBucket();
    expect(await code(rollbackTiles(client()))).toBe('tiles_no_previous');
    await publishTiles(client(), FIXTURE, A);
    expect(await code(rollbackTiles(client()))).toBe('tiles_no_previous');
    await publishTiles(client(), FIXTURE, B);
    r2.objects.delete(`tiles/${A}`);
    r2.log.length = 0;
    expect(await code(rollbackTiles(client()))).toBe('tiles_no_previous');
    expect(r2.current()).toEqual({ file: B, previous: A });
    expect(r2.log).not.toContain('PUT tiles/current.json');
  });
});
