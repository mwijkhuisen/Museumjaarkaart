import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { sha256Hex, sign } from '../../src/lib/sigv4.ts';
import { PART_MIN_BYTES, PUT_MAX_BYTES, R2Client, R2Error, readR2Config, validKey } from '../../src/media/r2.ts';
import { JobError } from '../../src/worker/types.ts';

// The R2 client against msw (A§18: no test reaches the network). Credentials are random per run, so no
// key-shaped literal is committed and a leak check can look for the exact values.

const KEY_ID = `AKIA${randomBytes(8).toString('hex').toUpperCase()}`;
const SECRET = randomBytes(30).toString('base64');
const CREDS = { accessKeyId: KEY_ID, secretAccessKey: SECRET };
const ORIGIN = 'https://r2.test';
const BUCKET = 'mjk-media';
const UPLOAD_ID = 'UP-1_x/y+z=';
const MARKER = 'BODY-MARKER-7f3a';
const META = { contentType: 'application/json', cacheControl: 'public, max-age=60' };

const client = (timeoutMs = 2000) =>
  new R2Client({ endpoint: ORIGIN, bucket: BUCKET, region: 'auto', credentials: CREDS, timeoutMs });

type Seen = { method: string; url: URL; headers: Headers; body: Uint8Array };

/** Records every request to the endpoint and answers with `answer` (default 200). */
function record(answer: (r: Seen, i: number) => Response | Promise<Response> = () => new HttpResponse(null)) {
  const seen: Seen[] = [];
  server.use(
    http.all(`${ORIGIN}/*`, async ({ request }) => {
      const r = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      };
      seen.push(r);
      return answer(r, seen.length - 1);
    }),
  );
  return seen;
}

/** Recomputes the signature from what arrived: what was sent is what was signed. */
function verified(r: Seen): boolean {
  const auth = r.headers.get('authorization') ?? '';
  const signed = /,SignedHeaders=([a-z0-9;-]+),Signature=[0-9a-f]{64}$/.exec(auth)?.[1] ?? '';
  const date = (r.headers.get('x-amz-date') ?? '').replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  );
  const own = new Set(['host', 'x-amz-date', 'x-amz-content-sha256']);
  const headers = Object.fromEntries(
    signed
      .split(';')
      .filter((n) => !own.has(n))
      .map((n) => [n, r.headers.get(n) ?? '']),
  );
  const again = sign(
    {
      method: r.method,
      host: r.url.host,
      path: decodeURIComponent(r.url.pathname),
      query: Object.fromEntries(r.url.searchParams),
      headers,
      body: r.body,
    },
    CREDS,
    { region: 'auto', service: 's3' },
    new Date(date),
  );
  return again.headers.authorization === auth && r.headers.get('x-amz-content-sha256') === sha256Hex(r.body);
}

async function rejection(p: Promise<unknown>): Promise<R2Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(R2Error);
  return err as R2Error;
}

const tempFile = (bytes: Uint8Array) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mjk-r2-')), 'f.bin');
  writeFileSync(path, bytes);
  return path;
};

/** A multipart server: create, parts, complete, abort; `fail` overrides one answer. */
function multipart(fail?: (r: Seen) => Response | undefined) {
  return record((r) => {
    const failed = fail?.(r);
    if (failed !== undefined) return failed;
    const q = r.url.searchParams;
    if (r.method === 'POST' && q.has('uploads')) {
      return HttpResponse.xml(
        `<InitiateMultipartUploadResult><UploadId>${UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (r.method === 'PUT' && q.has('partNumber')) {
      return new HttpResponse(null, { headers: { ETag: `"${sha256Hex(r.body).slice(0, 32)}"` } });
    }
    if (r.method === 'POST' && q.has('uploadId')) {
      return HttpResponse.xml('<CompleteMultipartUploadResult><ETag>"x-3"</ETag></CompleteMultipartUploadResult>');
    }
    if (r.method === 'DELETE') return new HttpResponse(null, { status: 204 });
    return new HttpResponse(null, { status: 400 });
  });
}

const aborts = (seen: Seen[]) =>
  seen.filter((r) => r.method === 'DELETE' && r.url.searchParams.get('uploadId') === UPLOAD_ID).length;

describe('keys', () => {
  it.each([['tiles/current.json'], ['tiles/nl-20261101.pmtiles'], ['p/0123abcd/400.avif'], ['a'], ['a_b-c.d/e']])(
    'accepts %j',
    (key) => {
      expect(validKey(key)).toBe(true);
    },
  );

  const bad = [
    '',
    '../x',
    'a/../b',
    'a..b',
    '/a',
    'a/',
    'a//b',
    '.a',
    'a/.b',
    '-a',
    'A',
    'a b',
    'a?b',
    'a#b',
    'a%2fb',
    'a\\b',
    'é',
    'a\nb',
    'x'.repeat(1025),
  ];

  it.each(bad.map((k) => [k]))('refuses %j before any request', async (key) => {
    const seen = record();
    const c = client();
    const path = tempFile(new Uint8Array(1));
    for (const p of [
      c.put(key, 'x', META),
      c.get(key, { maxBytes: 10 }),
      c.head(key),
      c.delete(key),
      c.send({ method: 'GET', key }),
      c.putFile(key, path, META),
    ]) {
      expect((await rejection(p)).code).toBe('store_bad_key');
    }
    expect(seen).toEqual([]);
  });
});

describe('put, get, head, delete', () => {
  it('signs a PUT with the body hash, its content type and cache control, path-style', async () => {
    const seen = record();
    await client().put('tiles/current.json', '{"file":"nl-1.pmtiles"}', META);
    expect(seen).toHaveLength(1);
    const [r] = seen as [Seen];
    expect(r.method).toBe('PUT');
    expect(r.url.href).toBe(`${ORIGIN}/${BUCKET}/tiles/current.json`);
    expect(new TextDecoder().decode(r.body)).toBe('{"file":"nl-1.pmtiles"}');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(r.headers.get('x-amz-content-sha256')).toBe(sha256Hex('{"file":"nl-1.pmtiles"}'));
    expect(r.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(r.headers.get('authorization')).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/auto/s3/aws4_request,` +
          'SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$',
      ),
    );
    expect(verified(r)).toBe(true);
  });

  it('gets the bytes, null for a missing key (whatever its error body), and caps the body', async () => {
    const big = `<Error><Code>NoSuchKey</Code><Message>${'x'.repeat(500)}</Message></Error>`;
    record((r) =>
      r.url.pathname.endsWith('/there')
        ? new HttpResponse(new Uint8Array([1, 2, 3]))
        : r.url.pathname.endsWith('/big')
          ? new HttpResponse(new Uint8Array(11))
          : HttpResponse.xml(big, { status: 404 }),
    );
    const c = client();
    expect(Buffer.from((await c.get('there', { maxBytes: 3 })) ?? [])).toEqual(Buffer.from([1, 2, 3]));
    expect(await c.get('missing', { maxBytes: 10 })).toBeNull();
    const err = await rejection(c.get('big', { maxBytes: 10 }));
    expect(err.code).toBe('store_too_large');
  });

  it('heads to size and ETag, null when missing; a 200 without them is a bad response', async () => {
    record((r) =>
      r.url.pathname.endsWith('/there')
        ? new HttpResponse(null, { headers: { 'Content-Length': '1234', ETag: '"abc"' } })
        : r.url.pathname.endsWith('/odd')
          ? new HttpResponse(null)
          : new HttpResponse(null, { status: 404 }),
    );
    const c = client();
    expect(await c.head('there')).toEqual({ size: 1234, etag: '"abc"' });
    expect(await c.head('missing')).toBeNull();
    expect((await rejection(c.head('odd'))).code).toBe('store_bad_response');
  });

  it('deletes: 204 and 404 are both fine, a 403 is store_denied', async () => {
    const seen = record((_r, i) => new HttpResponse(null, { status: [204, 404, 403][i] ?? 500 }));
    const c = client();
    await c.delete('a');
    await c.delete('a');
    const err = await rejection(c.delete('a'));
    expect(err.code).toBe('store_denied');
    expect(err.status).toBe(403);
    expect(err.retry).toBe(false);
    expect(seen.map((r) => r.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
  });

  it('maps statuses to codes, reads S3 error codes and marks only transient ones for retry', async () => {
    const statuses = [400, 401, 409, 429, 500, 503];
    record((_r, i) => HttpResponse.xml(`<Error><Code>Code${i}</Code></Error>`, { status: statuses[i] ?? 500 }));
    const c = client();
    const out = [];
    for (const _ of statuses) {
      const e = await rejection(c.put('k', 'x', META));
      out.push([e.code, e.status, e.s3Code, e.retry]);
    }
    expect(out).toEqual([
      ['store_rejected', 400, 'Code0', false],
      ['store_denied', 401, 'Code1', false],
      ['store_rejected', 409, 'Code2', false],
      ['store_unavailable', 429, 'Code3', true],
      ['store_unavailable', 500, 'Code4', true],
      ['store_unavailable', 503, 'Code5', true],
    ]);
  });

  it('refuses a PUT over the cap before any request', async () => {
    const seen = record();
    expect((await rejection(client().put('k', new Uint8Array(PUT_MAX_BYTES + 1), META))).code).toBe('store_too_large');
    expect(seen).toEqual([]);
  });

  it('refuses a header value that is not printable ASCII', async () => {
    const seen = record();
    const err = await rejection(client().put('k', 'x', { ...META, cacheControl: 'a\r\nx-evil: 1' }));
    expect(err.code).toBe('store_bad_request');
    expect(seen).toEqual([]);
  });

  it('refuses a query value that cannot be encoded', async () => {
    const seen = record();
    const err = await rejection(client().send({ method: 'GET', query: { prefix: '\u{D800}' } }));
    expect(err.code).toBe('store_bad_request');
    expect(seen).toEqual([]);
  });

  it('is a JobError, so the worker stores its code', async () => {
    const err = await rejection(client().put('../k', 'x', META));
    expect(err).toBeInstanceOf(JobError);
  });
});

describe('the transport', () => {
  it.each([[301], [302], [303], [307], [308]])('never follows a %i', async (status) => {
    let followed = 0;
    server.use(
      http.all('https://elsewhere.test/*', () => {
        followed++;
        return new HttpResponse('ok');
      }),
    );
    record(() => new HttpResponse(null, { status, headers: { Location: 'https://elsewhere.test/x' } }));
    const err = await rejection(client().get('k', { maxBytes: 10 }));
    expect(err.code).toBe('store_unavailable');
    expect(followed).toBe(0);
  });

  it('times out a request that hangs', async () => {
    record(async () => {
      await delay('infinite');
      return new HttpResponse(null);
    });
    const started = Date.now();
    const err = await rejection(client(50).head('k'));
    expect(err.code).toBe('store_timeout');
    expect(err.retry).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops on the caller's signal", async () => {
    const seen = record(async () => {
      await delay('infinite');
      return new HttpResponse(null);
    });
    const ac = new AbortController();
    const p = client().get('k', { maxBytes: 10, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect((await rejection(p)).code).toBe('store_aborted');
    expect(seen).toHaveLength(1);
    expect((await rejection(client().head('k', { signal: AbortSignal.abort() }))).code).toBe('store_aborted');
  });

  it('turns a network error into store_unavailable', async () => {
    record(() => HttpResponse.error());
    expect((await rejection(client().head('k'))).code).toBe('store_unavailable');
  });

  it('addresses the bucket itself through send, with the query signed', async () => {
    const seen = record(() => new HttpResponse(null, { status: 204 }));
    const res = await client().send({ method: 'PUT', query: { policy: '' }, body: '{}' });
    expect(res.status).toBe(204);
    expect(seen[0]?.url.href).toBe(`${ORIGIN}/${BUCKET}?policy=`);
    expect(verified(seen[0] as Seen)).toBe(true);
  });
});

describe('putFile', () => {
  const MIB = 1024 * 1024;
  const bytes = randomBytes(11 * MIB);

  it('uploads 11 MiB in 5 MiB parts, each signed with its own hash, then completes with every ETag', async () => {
    const seen = multipart();
    await client().putFile('tiles/nl-1.pmtiles', tempFile(bytes), { ...META, partSize: 5 * MIB });
    expect(seen.map((r) => `${r.method} ${r.url.search}`)).toEqual([
      'POST ?uploads=',
      `PUT ?partNumber=1&uploadId=${encodeURIComponent(UPLOAD_ID)}`,
      `PUT ?partNumber=2&uploadId=${encodeURIComponent(UPLOAD_ID)}`,
      `PUT ?partNumber=3&uploadId=${encodeURIComponent(UPLOAD_ID)}`,
      `POST ?uploadId=${encodeURIComponent(UPLOAD_ID)}`,
    ]);
    for (const r of seen) expect(verified(r)).toBe(true);
    const [create, p1, p2, p3, complete] = seen as [Seen, Seen, Seen, Seen, Seen];
    expect(create.headers.get('content-type')).toBe('application/json');
    expect(create.headers.get('cache-control')).toBe('public, max-age=60');
    expect(Buffer.concat([p1.body, p2.body, p3.body]).equals(bytes)).toBe(true);
    expect([p1.body.byteLength, p2.body.byteLength, p3.body.byteLength]).toEqual([5 * MIB, 5 * MIB, MIB]);
    expect(p2.headers.get('x-amz-content-sha256')).toBe(sha256Hex(bytes.subarray(5 * MIB, 10 * MIB)));
    const tags = [p1, p2, p3].map((p) => `"${sha256Hex(p.body).slice(0, 32)}"`);
    expect(new TextDecoder().decode(complete.body)).toBe(
      `<CompleteMultipartUpload>${tags.map((t, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${t}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
    );
  });

  it('sends a file that fits in one part as a single PUT', async () => {
    const seen = record();
    await client().putFile('k', tempFile(bytes.subarray(0, 100)), META);
    expect(seen.map((r) => `${r.method} ${r.url.search}`)).toEqual(['PUT ']);
    expect(seen[0]?.body).toEqual(new Uint8Array(bytes.subarray(0, 100)));
  });

  it('aborts the upload when a part fails, and rethrows', async () => {
    const seen = multipart((r) =>
      r.url.searchParams.get('partNumber') === '2' ? new HttpResponse(null, { status: 500 }) : undefined,
    );
    const err = await rejection(client().putFile('k', tempFile(bytes), { ...META, partSize: 5 * MIB }));
    expect([err.code, err.status]).toEqual(['store_unavailable', 500]);
    expect(aborts(seen)).toBe(1);
    expect(seen.some((r) => r.url.searchParams.get('partNumber') === '3')).toBe(false);
    expect(seen.at(-1)?.method).toBe('DELETE');
  });

  it("aborts the upload when the caller's signal fires mid-upload", async () => {
    const ac = new AbortController();
    const seen = multipart((r) => {
      if (r.url.searchParams.get('partNumber') === '1') ac.abort();
      return undefined;
    });
    const err = await rejection(
      client().putFile('k', tempFile(bytes), { ...META, partSize: 5 * MIB, signal: ac.signal }),
    );
    expect(err.code).toBe('store_aborted');
    expect(aborts(seen)).toBe(1);
  });

  it('aborts when CompleteMultipartUpload answers 200 with an error inside', async () => {
    const seen = multipart((r) =>
      r.method === 'POST' && r.url.searchParams.has('uploadId')
        ? HttpResponse.xml('<Error><Code>InternalError</Code></Error>')
        : undefined,
    );
    const err = await rejection(client().putFile('k', tempFile(bytes), { ...META, partSize: 5 * MIB }));
    expect([err.code, err.s3Code]).toEqual(['store_rejected', 'InternalError']);
    expect(aborts(seen)).toBe(1);
  });

  it('aborts when a part comes back without an ETag', async () => {
    const seen = multipart((r) => (r.url.searchParams.has('partNumber') ? new HttpResponse(null) : undefined));
    const err = await rejection(client().putFile('k', tempFile(bytes), { ...META, partSize: 5 * MIB }));
    expect(err.code).toBe('store_bad_response');
    expect(aborts(seen)).toBe(1);
  });

  it('stops when the create answer has no UploadId', async () => {
    const seen = multipart((r) => (r.url.searchParams.has('uploads') ? HttpResponse.xml('<x/>') : undefined));
    const err = await rejection(client().putFile('k', tempFile(bytes), { ...META, partSize: 5 * MIB }));
    expect(err.code).toBe('store_bad_response');
    expect(seen).toHaveLength(1);
  });

  it('refuses a missing file, a part under 5 MiB or over the cap, before any request', async () => {
    const seen = record();
    const c = client();
    expect((await rejection(c.putFile('k', '/nonexistent/mjk-r2', META))).code).toBe('store_file_unreadable');
    const path = tempFile(new Uint8Array(1));
    for (const partSize of [PART_MIN_BYTES - 1, PUT_MAX_BYTES + 1, 5 * MIB + 0.5]) {
      expect((await rejection(c.putFile('k', path, { ...META, partSize }))).code).toBe('store_bad_request');
    }
    expect(seen).toEqual([]);
  });
});

describe('readR2Config', () => {
  const secretFile = (text: string) => tempFile(new TextEncoder().encode(text));
  const env = { MJK_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com', MJK_R2_BUCKET_MEDIA: 'mjk-media' };
  const good = `[default]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key=${SECRET}\n`;

  it('reads the endpoint, the bucket and the [default] key of the credentials file', () => {
    const cfg = readR2Config(env, secretFile(`# r2_media_rw\n[other]\naws_access_key_id=nope1\n\n${good}`));
    expect(cfg.endpoint).toBe('https://acct.eu.r2.cloudflarestorage.com');
    expect([cfg.bucket, cfg.region]).toEqual(['mjk-media', 'auto']);
    expect([cfg.credentials.accessKeyId, cfg.credentials.secretAccessKey]).toEqual([KEY_ID, SECRET]);
    // The credentials are not enumerable: printing the config shows neither value.
    for (const text of [inspect(cfg, { depth: 9 }), JSON.stringify(cfg)]) {
      expect(text).not.toContain(KEY_ID);
      expect(text).not.toContain(SECRET);
    }
    expect(() => new R2Client(cfg)).not.toThrow();
  });

  it.each([
    [{ MJK_R2_ENDPOINT: undefined }, 'store_endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: '' }, 'store_endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'http://acct.r2.cloudflarestorage.com' }, 'store_endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com:8443' }, 'store_endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/bucket' }, 'store_endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/?x=1' }, 'store_endpoint_invalid'],
    [
      { MJK_R2_ENDPOINT: `https://${KEY_ID}:${encodeURIComponent(SECRET)}@acct.r2.cloudflarestorage.com` },
      'store_endpoint_invalid',
    ],
    [{ MJK_R2_ENDPOINT: 'not a url' }, 'store_endpoint_invalid'],
    [{ MJK_R2_BUCKET_MEDIA: '' }, 'store_bucket_invalid'],
    [{ MJK_R2_BUCKET_MEDIA: 'Mjk_Media' }, 'store_bucket_invalid'],
    [{ MJK_R2_BUCKET_MEDIA: 'a..b' }, 'store_bucket_invalid'],
  ] as const)('refuses %j with %s, naming the variable', (overrides, code) => {
    const e = (() => {
      try {
        readR2Config({ ...env, ...overrides }, secretFile(good));
      } catch (err) {
        return err as R2Error;
      }
      throw new Error('no error');
    })();
    expect(e.code).toBe(code);
    expect(e.message).toContain(code === 'store_endpoint_invalid' ? 'MJK_R2_ENDPOINT' : 'MJK_R2_BUCKET_MEDIA');
    expect(`${e.message} ${e.stack}`).not.toContain(KEY_ID);
  });

  it.each([
    ['', 'store_secret_invalid'],
    [`aws_access_key_id=${KEY_ID}\naws_secret_access_key=${SECRET}\n`, 'store_secret_invalid'],
    [`[default]\naws_access_key_id ${KEY_ID}\naws_secret_access_key=${SECRET}\n`, 'store_secret_invalid'],
    [`[default]\naws_access_key_id=${KEY_ID}\n`, 'store_secret_invalid'],
    [`[default]\naws_access_key_id=${KEY_ID}/x\naws_secret_access_key=${SECRET}\n`, 'store_secret_invalid'],
    [`[default]\naws_access_key_id=${KEY_ID}\naws_secret_access_key=has space ${SECRET}\n`, 'store_secret_invalid'],
  ])('refuses the credentials file %#', (text, code) => {
    const path = secretFile(text);
    expect(() => readR2Config(env, path)).toThrow(
      expect.objectContaining({ code, message: expect.stringContaining(path) }),
    );
  });

  it('refuses a missing file', () => {
    expect(() => readR2Config(env, '/nonexistent/r2_media_rw')).toThrow(
      expect.objectContaining({
        code: 'store_secret_missing',
        message: expect.stringContaining('/nonexistent/r2_media_rw'),
      }),
    );
  });
});

describe('no secret leaks', () => {
  const MIB = 1024 * 1024;
  const sigDoesNotMatch = () =>
    HttpResponse.xml(
      `<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId>` +
        `<StringToSign>AWS4-HMAC-SHA256 Signature=abc</StringToSign><CanonicalRequest>PUT ?uploadId=${UPLOAD_ID}` +
        `</CanonicalRequest><Message>${MARKER}</Message></Error>`,
      { status: 403 },
    );

  const cases: [string, () => Promise<unknown>][] = [
    ['bad key', () => client().put('../x', 'x', META)],
    ['too large', () => client().put('k', new Uint8Array(PUT_MAX_BYTES + 1), META)],
    ['bad header', () => client().put('k', 'x', { ...META, contentType: `\n${SECRET}` })],
    [
      'denied with S3 quoting the request',
      () => {
        record(sigDoesNotMatch);
        return client().put('k', 'x', META);
      },
    ],
    [
      'rejected',
      () => {
        record(() =>
          HttpResponse.xml(`<Error><Code>BadDigest</Code><Message>${MARKER}</Message></Error>`, { status: 400 }),
        );
        return client().get('k', { maxBytes: 10 });
      },
    ],
    [
      'unavailable',
      () => {
        record(() => new HttpResponse(MARKER, { status: 503 }));
        return client().head('k');
      },
    ],
    [
      'network error',
      () => {
        record(() => HttpResponse.error());
        return client().delete('k');
      },
    ],
    [
      'redirect',
      () => {
        record(() => new HttpResponse(MARKER, { status: 307, headers: { Location: `${ORIGIN}/${MARKER}` } }));
        return client().get('k', { maxBytes: 10 });
      },
    ],
    [
      'timeout',
      () => {
        record(async () => {
          await delay('infinite');
          return new HttpResponse(null);
        });
        return client(30).get('k', { maxBytes: 10 });
      },
    ],
    ['aborted', () => client().head('k', { signal: AbortSignal.abort(new Error(SECRET)) })],
    [
      'body over the cap',
      () => {
        record(() => new HttpResponse(`${MARKER}${'x'.repeat(100)}`));
        return client().get('k', { maxBytes: 10 });
      },
    ],
    [
      'bad head answer',
      () => {
        record(() => new HttpResponse(null));
        return client().head('k');
      },
    ],
    [
      'multipart: a part denied',
      () => {
        multipart((r) => (r.url.searchParams.has('partNumber') ? sigDoesNotMatch() : undefined));
        return client().putFile('k', tempFile(randomBytes(6 * MIB)), { ...META, partSize: 5 * MIB });
      },
    ],
    [
      'multipart: complete fails inside a 200',
      () => {
        multipart((r) =>
          r.method === 'POST' && r.url.searchParams.has('uploadId')
            ? HttpResponse.xml(`<Error><Code>InternalError</Code><Message>${MARKER} ${UPLOAD_ID}</Message></Error>`)
            : undefined,
        );
        return client().putFile('k', tempFile(randomBytes(6 * MIB)), { ...META, partSize: 5 * MIB });
      },
    ],
    [
      'multipart: aborted, and the abort itself fails',
      () => {
        const ac = new AbortController();
        multipart((r) => {
          if (r.url.searchParams.has('partNumber')) ac.abort();
          return r.method === 'DELETE' ? new HttpResponse(MARKER, { status: 500 }) : undefined;
        });
        return client().putFile('k', tempFile(randomBytes(6 * MIB)), { ...META, partSize: 5 * MIB, signal: ac.signal });
      },
    ],
    [
      'config: secret file without a section',
      async () => readR2Config({}, tempFile(new TextEncoder().encode(`aws_secret_access_key=${SECRET}`))),
    ],
    [
      'config: malformed secret file',
      async () =>
        readR2Config(
          { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'b-1' },
          tempFile(new TextEncoder().encode(`[default]\n${KEY_ID} ${SECRET}\n`)),
        ),
    ],
    [
      'config: credentials in the endpoint',
      async () => readR2Config({ MJK_R2_ENDPOINT: `https://${KEY_ID}:x@r2.test`, MJK_R2_BUCKET_MEDIA: 'b-1' }),
    ],
    [
      'constructor: a bad secret',
      async () =>
        new R2Client({
          endpoint: ORIGIN,
          bucket: BUCKET,
          region: 'auto',
          credentials: { accessKeyId: KEY_ID, secretAccessKey: `${SECRET} x` },
        }),
    ],
  ];

  const forbidden = [
    KEY_ID,
    SECRET,
    'Signature=',
    'AWS4-HMAC',
    'Credential=',
    MARKER,
    UPLOAD_ID,
    'uploadId',
    'partNumber',
  ];

  it.each(cases)('%s', async (_name, run) => {
    const err = await rejection(run());
    const c = client();
    const texts = [
      err.message,
      String(err),
      JSON.stringify(err),
      err.stack ?? '',
      inspect(err, { depth: 9, showHidden: true }),
      inspect(c, { depth: 9, showHidden: true }),
      JSON.stringify(c),
    ];
    for (const text of texts) {
      for (const bad of forbidden) expect(text).not.toContain(bad);
      expect(text.toLowerCase()).not.toContain('authorization');
    }
    expect(err.code).toMatch(/^[a-z_]{1,40}$/);
  });
});
