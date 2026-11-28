import { createHash } from 'node:crypto';
import { CHUNK_BYTES, PHOTO_MAX_BYTES } from '@mjk/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFile, sha256Hex, UploadError, uploadPhoto } from '../src/lib/upload.ts';

// The chunked upload against a mocked fetch (P3b WP7): chunk boundaries, the hash, the retry rule, a 4xx that
// stops, the poll, and a check before any request.

const ID = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const MUSEUM = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = (state: string) => ({ id: ID, state, error_code: null, keys: [] });
const instant = async () => {};
const png = (size: number) => new Blob([new Uint8Array(size).fill(7)], { type: 'image/png' });

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A server that takes every chunk; `chunk` may answer a given call differently (by its running number). */
function server(opts: { chunk?: (call: number, n: number) => Response | Error; states?: string[] } = {}) {
  const calls: Call[] = [];
  const sizes: number[] = [];
  let chunkCalls = 0;
  const states = [...(opts.states ?? ['pending_review'])];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: new Headers(init?.headers), body: init?.body });
    const chunk = /\/chunks\/(\d+)$/.exec(url);
    if (chunk !== null) {
      sizes.push((init?.body as Blob | undefined)?.size ?? 0);
      const answer = opts.chunk?.(chunkCalls++, Number(chunk[1]));
      if (answer instanceof Error) throw answer;
      return answer ?? new Response(null, { status: 204 });
    }
    if (url.endsWith('/uploads') && method === 'POST') {
      const size = (JSON.parse(String(init?.body)) as { size: number }).size;
      return json(201, { id: ID, chunk_size: CHUNK_BYTES, chunk_count: Math.ceil(size / CHUNK_BYTES) });
    }
    if (url.endsWith('/complete')) return json(202, status('quarantined'));
    return json(200, status(states.length > 1 ? (states.shift() as string) : (states[0] as string)));
  });
  vi.stubGlobal('fetch', fn);
  return { calls, sizes, chunks: () => calls.filter((c) => c.url.includes('/chunks/')) };
}

afterEach(() => vi.unstubAllGlobals());

describe('checkFile', () => {
  it('takes JPEG, PNG and WebP up to 25 MiB and nothing else', () => {
    expect(checkFile({ size: 1, type: 'image/jpeg' })).toBeNull();
    expect(checkFile({ size: PHOTO_MAX_BYTES, type: 'image/webp' })).toBeNull();
    expect(checkFile({ size: PHOTO_MAX_BYTES + 1, type: 'image/png' })).toBe('size');
    expect(checkFile({ size: 0, type: 'image/png' })).toBe('size');
    expect(checkFile({ size: 10, type: 'image/heic' })).toBe('type');
    expect(checkFile({ size: 10, type: '' })).toBe('type');
  });

  it('refuses before any request', async () => {
    const s = server();
    await expect(uploadPhoto(new Blob(['x'], { type: 'image/heic' }), { museumId: MUSEUM })).rejects.toMatchObject({
      code: 'type',
    });
    expect(s.calls).toHaveLength(0);
  });
});

describe('uploadPhoto chunking', () => {
  it.each([
    [1, [1]],
    [CHUNK_BYTES, [CHUNK_BYTES]],
    [CHUNK_BYTES + 1, [CHUNK_BYTES, 1]],
    [PHOTO_MAX_BYTES, [CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 1024 * 1024]],
  ])('%i bytes go in the chunks %j, as octet-stream, in order', async (size, expected) => {
    const s = server();
    const progress: number[] = [];
    const result = await uploadPhoto(png(size), {
      museumId: MUSEUM,
      wait: instant,
      onProgress: (sent) => progress.push(sent),
    });
    expect(result.state).toBe('pending_review');
    expect(s.sizes).toEqual(expected);
    expect(s.chunks().map((c) => c.url)).toEqual(expected.map((_, n) => `/api/v1/uploads/${ID}/chunks/${n}`));
    for (const c of s.chunks()) {
      expect(c.method).toBe('PUT');
      expect(c.headers.get('content-type')).toBe('application/octet-stream');
    }
    expect(progress.at(-1)).toBe(size);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('creates with the declared size, type, museum, the review when given and the three consents', async () => {
    const s = server();
    await uploadPhoto(png(10), { museumId: MUSEUM, reviewId: ID, wait: instant });
    expect(JSON.parse(String(s.calls[0]?.body))).toEqual({
      kind: 'photo',
      size: 10,
      type: 'image/png',
      museum_id: MUSEUM,
      review_id: ID,
      consents: { own_photo: true, no_people: true, no_artwork: true },
    });
  });

  it('completes with the whole file`s sha256 in lower-case hex', async () => {
    const s = server();
    const file = png(CHUNK_BYTES + 5);
    await uploadPhoto(file, { museumId: MUSEUM, wait: instant });
    const complete = s.calls.find((c) => c.url.endsWith('/complete'));
    const want = createHash('sha256')
      .update(new Uint8Array(CHUNK_BYTES + 5).fill(7))
      .digest('hex');
    expect(JSON.parse(String(complete?.body))).toEqual({ sha256: want });
    expect(await sha256Hex(file)).toBe(want);
  });
});

describe('uploadPhoto retries', () => {
  it('retries a network error, a 5xx and a 409 up to three times, then goes on', async () => {
    const answers = [
      new TypeError('offline'),
      new Response(null, { status: 503 }),
      new Response(null, { status: 409 }),
    ];
    const s = server({ chunk: (call) => answers[call] ?? new Response(null, { status: 204 }) });
    await uploadPhoto(png(5), { museumId: MUSEUM, wait: instant });
    expect(s.chunks()).toHaveLength(4);
  });

  it('gives up after the third retry', async () => {
    const s = server({ chunk: () => new Response(null, { status: 500 }) });
    await expect(uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(s.chunks()).toHaveLength(4);
  });

  it('reports a network error that never ends as `network`', async () => {
    server({ chunk: () => new TypeError('offline') });
    await expect(uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).rejects.toMatchObject({ code: 'network' });
  });

  it('stops at once on another 4xx', async () => {
    const s = server({ chunk: () => json(422, { error: 'invalid', fields: ['length'] }) });
    const error = await uploadPhoto(png(5), { museumId: MUSEUM, wait: instant }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe('rejected');
    expect(s.chunks()).toHaveLength(1);
    expect(s.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });
});

describe('uploadPhoto create and poll', () => {
  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
    );
  };

  it.each([
    [415, { error: 'unsupported_type' }, 'type'],
    [422, { error: 'invalid', fields: ['consents'] }, 'consents'],
    [422, { error: 'invalid', fields: ['size'] }, 'size'],
    [422, { error: 'invalid', fields: ['photos'] }, 'photos'],
    [503, { error: 'unavailable' }, 'unavailable'],
  ])('maps a %i on create to `%s`', async (code, body, want) => {
    failing(code, body);
    await expect(uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).rejects.toMatchObject({ code: want });
  });

  it('maps a 429 to rate_limited', async () => {
    failing(429, { error: 'rate_limited' }, { 'retry-after': '60' });
    await expect(uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('polls until a final state, backing off', async () => {
    const s = server({ states: ['quarantined', 'processing', 'approved'] });
    const waits: number[] = [];
    const result = await uploadPhoto(png(5), {
      museumId: MUSEUM,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.state).toBe('approved');
    expect(s.calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('returns `failed` as a result', async () => {
    server({ states: ['failed'] });
    expect((await uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).state).toBe('failed');
  });

  it('stops waiting after a few minutes and says so', async () => {
    server({ states: ['processing'] });
    await expect(uploadPhoto(png(5), { museumId: MUSEUM, wait: instant })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
