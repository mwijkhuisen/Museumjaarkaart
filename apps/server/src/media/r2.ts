import { readFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { type Credentials, type Signed, sign } from '../lib/sigv4.ts';
import { JobError } from '../worker/types.ts';

// The object client for one R2 bucket (A§12, A§15.3, ADR-0008), path-style (`<endpoint>/<bucket>/<key>`,
// which R2's S3 API and MinIO both take), on the global fetch (msw sees it). A URL is only ever the
// configured origin, the bucket and a key that passed KEY, encoded by the signer, so no other host is
// reachable. No redirect is followed, every request has a timeout and every answer is read to a cap.
// The credentials live in #private fields. An error has a fixed code and the HTTP status, never a key,
// a signature, a header, a query string or the answer's body (invariants 1 and 8). Nothing here logs,
// and nothing retries: the job does. No presigned URLs (ADR-0008).

export const MEDIA_SECRET_PATH = '/run/secrets/r2_media_rw';
/** The largest single PUT and the largest part: what one request holds in memory. */
export const PUT_MAX_BYTES = 64 * 1024 * 1024;
/** R2 and S3: every part but the last is at least 5 MiB. */
export const PART_MIN_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PART_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** Per request; a 32 MiB part over a slow home line fits in it. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** AbortMultipartUpload runs after a failure or a shutdown, so it gets a short timeout of its own. */
const CLEANUP_TIMEOUT_MS = 30_000;
/** The cap on an answer that is parsed (XML) or only read for its error code. */
const SMALL_BODY = 64 * 1024;

const KEY = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const KEY_ID = /^[A-Za-z0-9_.-]{3,128}$/;
const SECRET = /^[\x21-\x7e]{8,256}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;
const UPLOAD_ID = /<UploadId>([A-Za-z0-9._~+/=-]{1,1024})<\/UploadId>/;
const ETAG = /^"?[A-Za-z0-9-]{1,128}"?$/;
const S3_CODE = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/;

type Env = Readonly<Record<string, string | undefined>>;

/** Lower case, digits and `._-`, segments that start with a letter or digit, at most 1024 bytes, no `..`. */
export const validKey = (key: string): boolean => key.length <= 1024 && !key.includes('..') && KEY.test(key);

const RETRY = new Set(['store_unavailable', 'store_timeout', 'store_aborted']);

/**
 * A JobError, so the worker stores the code: store_bad_key, store_bad_request, store_too_large, store_timeout,
 * store_aborted, store_unavailable (network, 408, 429, 5xx, a redirect), store_denied (401, 403), store_rejected
 * (other statuses), store_bad_response, store_file_unreadable and the config codes. `s3Code` is S3's own
 * `<Code>` (`NoSuchBucket`, `SignatureDoesNotMatch`), letters only.
 */
export class R2Error extends JobError {
  readonly status: number | undefined;
  readonly s3Code: string | undefined;

  constructor(code: string, opts: { status?: number; s3Code?: string | undefined; message?: string } = {}) {
    super(code, { retry: RETRY.has(code) });
    this.name = 'R2Error';
    this.status = opts.status;
    this.s3Code = opts.s3Code;
    if (opts.message !== undefined) this.message = opts.message;
  }
}

export type R2Options = {
  /** An origin: `https://<account>.eu.r2.cloudflarestorage.com`, or a stand-in's `http://127.0.0.1:<port>`. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2; MinIO wants a real one (`us-east-1`). */
  region: string;
  credentials: Credentials;
  timeoutMs?: number;
};

function originOf(endpoint: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  const plain =
    url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
  return plain && (url.protocol === 'https:' || url.protocol === 'http:') ? url : undefined;
}

const validBucket = (bucket: string) => BUCKET.test(bucket) && !bucket.includes('..');

/** Fields that are not enumerable, so inspect() and JSON.stringify() print `{}`. */
const hidden = (accessKeyId: string, secretAccessKey: string): Credentials =>
  Object.defineProperties(
    {},
    {
      accessKeyId: { value: accessKeyId },
      secretAccessKey: { value: secretAccessKey },
    },
  ) as Credentials;

/** An AWS shared-credentials file (as `r2_backup_put`): the `[default]` section's key id and secret. */
function parseCredentials(text: string): Credentials | undefined {
  let section = '';
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) return undefined;
    if (section === 'default') values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const id = values.get('aws_access_key_id') ?? '';
  const secret = values.get('aws_secret_access_key') ?? '';
  return KEY_ID.test(id) && SECRET.test(secret) ? hidden(id, secret) : undefined;
}

/**
 * The media bucket's client options from the config and the file secret (A§17.3). Throws an R2Error
 * whose code and message name the variable or the file, never a value: the caller exits 78.
 */
export function readR2Config(env: Env, secretPath: string = MEDIA_SECRET_PATH): R2Options {
  const url = originOf(env.MJK_R2_ENDPOINT ?? '');
  if (url === undefined || url.protocol !== 'https:' || url.port !== '') {
    throw new R2Error('store_endpoint_invalid', { message: 'MJK_R2_ENDPOINT must be an https origin, port 443' });
  }
  const bucket = env.MJK_R2_BUCKET_MEDIA ?? '';
  if (!validBucket(bucket)) {
    throw new R2Error('store_bucket_invalid', { message: 'MJK_R2_BUCKET_MEDIA must be an S3 bucket name' });
  }
  let text: string;
  try {
    text = readFileSync(secretPath, 'utf8');
  } catch {
    throw new R2Error('store_secret_missing', { message: `the file secret ${secretPath} cannot be read` });
  }
  const credentials = parseCredentials(text);
  if (credentials === undefined) {
    throw new R2Error('store_secret_invalid', { message: `the file secret ${secretPath} has no valid [default] key` });
  }
  return { endpoint: url.origin, bucket, region: 'auto', credentials };
}

export type R2Response = { status: number; headers: Headers; body: Uint8Array };

export type SendInput = {
  method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';
  /** An object key; without one the request addresses the bucket (CreateBucket, PutBucketPolicy, ListMultipartUploads). */
  key?: string | undefined;
  query?: Readonly<Record<string, string>> | undefined;
  /** Lower-case names; all of them are signed. */
  headers?: Readonly<Record<string, string>> | undefined;
  body?: Uint8Array | string | undefined;
  /** The cap on a 2xx answer's body (default 64 KiB); more is store_too_large. */
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

type Meta = { contentType: string; cacheControl: string; signal?: AbortSignal | undefined };

const text = (body: Uint8Array) => new TextDecoder().decode(body);
const s3Code = (body: Uint8Array) => S3_CODE.exec(text(body))?.[1];

/** Throws unless the status is one of `ok`. */
function check(res: R2Response, ...ok: number[]): void {
  if (ok.includes(res.status)) return;
  const s = res.status;
  const code =
    s === 401 || s === 403
      ? 'store_denied'
      : s === 408 || s === 429 || s >= 500
        ? 'store_unavailable'
        : 'store_rejected';
  throw new R2Error(code, { status: s, s3Code: s3Code(res.body) });
}

/** A 2xx body over `max` is store_too_large; any other answer is only read for its code, cut at SMALL_BODY. */
async function readBody(res: Response, max: number): Promise<Uint8Array> {
  const limit = res.ok ? max : SMALL_BODY;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body !== null) {
    // Leaving the loop (break or throw) cancels the stream.
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > limit) {
        if (res.ok) throw new R2Error('store_too_large', { status: res.status });
        break;
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function readPart(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  try {
    while (done < length) {
      const { bytesRead } = await file.read(buf, done, length - done, offset + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
  } catch {
    throw new R2Error('store_file_unreadable');
  }
  // The file shrank under us.
  if (done !== length) throw new R2Error('store_file_unreadable');
  return buf;
}

export class R2Client {
  readonly #origin: string;
  readonly #host: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #timeoutMs: number;

  constructor(opts: R2Options) {
    const url = originOf(opts.endpoint);
    if (url === undefined)
      throw new R2Error('store_endpoint_invalid', { message: 'the R2 endpoint must be an origin' });
    if (!validBucket(opts.bucket)) throw new R2Error('store_bucket_invalid');
    if (!REGION.test(opts.region)) throw new R2Error('store_region_invalid');
    const { accessKeyId, secretAccessKey } = opts.credentials;
    if (!KEY_ID.test(accessKeyId) || !SECRET.test(secretAccessKey)) throw new R2Error('store_secret_invalid');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new R2Error('store_bad_request');
    this.#origin = url.origin;
    this.#host = url.host;
    this.#bucket = opts.bucket;
    this.#region = opts.region;
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
    this.#timeoutMs = timeoutMs;
  }

  /** One signed request. Throws an R2Error for a bad input, the transport or an oversized answer; never for a status. */
  async send(input: SendInput): Promise<R2Response> {
    if (input.key !== undefined && !validKey(input.key)) throw new R2Error('store_bad_key');
    const headers = input.headers ?? {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) throw new R2Error('store_bad_request');
    }
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : input.body;
    if (body !== undefined && body.byteLength > PUT_MAX_BYTES) throw new R2Error('store_too_large');
    const path = input.key === undefined ? `/${this.#bucket}` : `/${this.#bucket}/${input.key}`;
    let signed: Signed;
    try {
      signed = sign(
        { method: input.method, host: this.#host, path, query: input.query, headers, body },
        { accessKeyId: this.#accessKeyId, secretAccessKey: this.#secretAccessKey },
        { region: this.#region, service: 's3' },
        new Date(),
      );
    } catch {
      // A lone surrogate in a query value (URIError).
      throw new R2Error('store_bad_request');
    }
    const timeout = AbortSignal.timeout(input.timeoutMs ?? this.#timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    try {
      const res = await fetch(`${this.#origin}${signed.target}`, {
        method: input.method,
        headers: signed.headers,
        ...(body === undefined ? {} : { body }),
        // A redirect would carry a signed request to a host we did not choose.
        redirect: 'error',
        signal,
      });
      return { status: res.status, headers: res.headers, body: await readBody(res, input.maxBytes ?? SMALL_BODY) };
    } catch (err) {
      if (err instanceof R2Error) throw err;
      // Never the original error: its message or cause can quote the URL.
      throw new R2Error(
        input.signal?.aborted ? 'store_aborted' : timeout.aborted ? 'store_timeout' : 'store_unavailable',
      );
    }
  }

  /** A single PUT of at most PUT_MAX_BYTES. */
  async put(key: string, body: Uint8Array | string, opts: Meta): Promise<void> {
    const headers = { 'content-type': opts.contentType, 'cache-control': opts.cacheControl };
    check(await this.send({ method: 'PUT', key, headers, body, signal: opts.signal }), 200);
  }

  /** The object's bytes, or null when there is none. A body over `maxBytes` is store_too_large. */
  async get(key: string, opts: { maxBytes: number; signal?: AbortSignal | undefined }): Promise<Uint8Array | null> {
    const res = await this.send({ method: 'GET', key, maxBytes: opts.maxBytes, signal: opts.signal });
    if (res.status === 404) return null;
    check(res, 200);
    return res.body;
  }

  async head(key: string, opts: { signal?: AbortSignal } = {}): Promise<{ size: number; etag: string } | null> {
    const res = await this.send({ method: 'HEAD', key, signal: opts.signal });
    if (res.status === 404) return null;
    check(res, 200);
    const size = res.headers.get('content-length');
    const etag = res.headers.get('etag');
    if (size === null || !/^[0-9]{1,15}$/.test(size) || etag === null)
      throw new R2Error('store_bad_response', { status: 200 });
    return { size: Number(size), etag };
  }

  /** Deleting a missing object is fine. */
  async delete(key: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    check(await this.send({ method: 'DELETE', key, signal: opts.signal }), 200, 204, 404);
  }

  /**
   * A file on disk, one part in memory at a time (multipart; a file that fits in one part is a single PUT).
   * Any failure or abort after CreateMultipartUpload sends AbortMultipartUpload (best effort), then the
   * error is rethrown. An upload whose create answer was lost is left to the bucket's lifecycle rule.
   */
  async putFile(key: string, path: string, opts: Meta & { partSize?: number }): Promise<void> {
    if (!validKey(key)) throw new R2Error('store_bad_key');
    const partSize = opts.partSize ?? DEFAULT_PART_BYTES;
    if (!Number.isInteger(partSize) || partSize < PART_MIN_BYTES || partSize > PUT_MAX_BYTES) {
      throw new R2Error('store_bad_request');
    }
    const { signal } = opts;
    let file: FileHandle;
    try {
      file = await open(path, 'r');
    } catch {
      throw new R2Error('store_file_unreadable');
    }
    try {
      const { size } = await file.stat().catch(() => {
        throw new R2Error('store_file_unreadable');
      });
      if (size <= partSize) return await this.put(key, await readPart(file, 0, size), opts);
      const parts = Math.ceil(size / partSize);
      if (parts > MAX_PARTS) throw new R2Error('store_too_large');
      const headers = { 'content-type': opts.contentType, 'cache-control': opts.cacheControl };
      const created = await this.send({ method: 'POST', key, query: { uploads: '' }, headers, signal });
      check(created, 200);
      const uploadId = UPLOAD_ID.exec(text(created.body))?.[1];
      if (uploadId === undefined) throw new R2Error('store_bad_response', { status: 200 });
      try {
        const etags: string[] = [];
        for (let n = 1; n <= parts; n++) {
          const offset = (n - 1) * partSize;
          const body = await readPart(file, offset, Math.min(partSize, size - offset));
          const res = await this.send({ method: 'PUT', key, query: { partNumber: String(n), uploadId }, body, signal });
          check(res, 200);
          const etag = res.headers.get('etag');
          if (etag === null || !ETAG.test(etag)) throw new R2Error('store_bad_response', { status: 200 });
          etags.push(etag);
        }
        const list = etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('');
        const xml = `<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`;
        const done = await this.send({
          method: 'POST',
          key,
          query: { uploadId },
          headers: { 'content-type': 'application/xml' },
          body: xml,
          signal,
        });
        check(done, 200);
        // S3 may answer 200 and still fail: the error is then in the body.
        if (!text(done.body).includes('<CompleteMultipartUploadResult')) {
          throw new R2Error('store_rejected', { status: 200, s3Code: s3Code(done.body) });
        }
      } catch (err) {
        // Without the caller's signal, which may be the reason we are here.
        await this.send({ method: 'DELETE', key, query: { uploadId }, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => {});
        throw err;
      }
    } finally {
      await file.close().catch(() => {});
    }
  }
}
