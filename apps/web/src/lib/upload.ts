import {
  CHUNK_BYTES,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  UploadCreated,
  type UploadStatus,
  UploadStatus as UploadStatusSchema,
} from '@mjk/contracts';
import { ApiError, ApiFailure, getJson, sendJson } from './api.ts';

// The chunked photo upload (A§12, P3b): create, PUT each 8 MiB chunk, complete with the whole file's sha256, then
// poll until the worker is done. Errors are fixed codes (UploadError.code) that the UI maps to message keys; the
// server's text is never shown.

export type UploadErrorCode =
  | 'type'
  | 'size'
  | 'photos'
  | 'consents'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'network'
  | 'timeout'
  | 'other';

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode) {
    super(`upload_${code}`);
    this.code = code;
  }
}

export type UploadOptions = {
  museumId: string;
  reviewId?: string | undefined;
  onProgress?: (sent: number, total: number) => void;
  /** Called once the server has taken the whole file (state `quarantined`), before the polling starts. */
  onUploaded?: (id: string) => void;
  /** The pause between attempts and polls; tests pass an instant one. */
  wait?: (ms: number) => Promise<void>;
};

const CHUNK_RETRIES = 3;
const POLL_BUDGET_MS = 3 * 60_000;
const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The client's own check before any request: type and size (A§12). */
export function checkFile(file: { size: number; type: string }): 'type' | 'size' | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size < 1 || file.size > PHOTO_MAX_BYTES) return 'size';
  return null;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromApi(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  if (error instanceof ApiError) {
    if (error.status === 415) return new UploadError('type');
    if (error.status === 429) return new UploadError('rate_limited');
    if (error.status === 503) return new UploadError('unavailable');
    if (error.status === 422) {
      for (const f of ['consents', 'size', 'photos'] as const) if (error.fields.includes(f)) return new UploadError(f);
      return new UploadError('rejected');
    }
    return new UploadError('other');
  }
  if (error instanceof ApiFailure) return new UploadError('other');
  return new UploadError('network');
}

async function putChunk(id: string, n: number, body: Blob, wait: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let status = 0; // 0: a network error
    try {
      const res = await fetch(`/api/v1/uploads/${id}/chunks/${n}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      });
      if (res.ok) return;
      status = res.status;
      await res.body?.cancel();
    } catch {
      status = 0;
    }
    // A network error, a 5xx and a 409 (another request on this upload still runs) are retried; any other 4xx stops.
    const retry = status === 0 || status >= 500 || status === 409;
    if (!retry || attempt >= CHUNK_RETRIES) {
      if (status === 0) throw new UploadError('network');
      throw new UploadError(status === 429 ? 'rate_limited' : retry ? 'unavailable' : 'rejected');
    }
    await wait(500 * 2 ** attempt);
  }
}

const FINAL = new Set(['pending_review', 'approved', 'failed', 'rejected', 'removed']);

/**
 * Sends one photo and waits for the worker. Resolves with the final status (`failed` is a result, not a throw: its
 * `error_code` is the worker's fixed code); throws UploadError for anything that stopped the transfer or the wait.
 */
export async function uploadPhoto(file: Blob, opts: UploadOptions): Promise<UploadStatus> {
  const wait = opts.wait ?? defaultWait;
  const problem = checkFile(file);
  if (problem !== null) throw new UploadError(problem);
  const total = file.size;
  let id: string;
  let count: number;
  try {
    const created = await sendJson(
      'POST',
      '/api/v1/uploads',
      {
        kind: 'photo',
        size: total,
        type: file.type,
        museum_id: opts.museumId,
        ...(opts.reviewId === undefined ? {} : { review_id: opts.reviewId }),
        consents: { own_photo: true, no_people: true, no_artwork: true },
      },
      UploadCreated,
    );
    id = created.id;
    count = created.chunk_count;
  } catch (error) {
    throw fromApi(error);
  }
  opts.onProgress?.(0, total);
  for (let n = 0; n < count; n++) {
    await putChunk(id, n, file.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES), wait);
    opts.onProgress?.(Math.min(total, (n + 1) * CHUNK_BYTES), total);
  }
  try {
    await sendJson('POST', `/api/v1/uploads/${id}/complete`, { sha256: await sha256Hex(file) }, UploadStatusSchema);
  } catch (error) {
    throw fromApi(error);
  }
  opts.onUploaded?.(id);
  let waited = 0;
  for (let delay = 1000; waited <= POLL_BUDGET_MS; delay = Math.min(delay * 2, 5000)) {
    let status: UploadStatus;
    try {
      status = await getJson(`/api/v1/uploads/${id}`, UploadStatusSchema);
    } catch (error) {
      throw fromApi(error);
    }
    if (FINAL.has(status.state)) return status;
    await wait(delay);
    waited += delay;
  }
  throw new UploadError('timeout');
}
