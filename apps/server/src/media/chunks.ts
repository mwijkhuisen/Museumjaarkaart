import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { CHUNK_BYTES } from './limits.ts';

// One chunk of an upload (A§12): streamed from the request body straight into the upload file at its own
// offset, with a byte counter and a running sha256. Nothing is buffered beyond what the stream hands over, and
// no write ever reaches past this chunk's expected end, so the file can never pass the declared size.

/** The exact length chunk `n` of an upload of `size` bytes must have: 8 MiB, the last one the remainder. */
export function chunkLength(size: number, chunkCount: number, n: number): number {
  return n < chunkCount - 1 ? CHUNK_BYTES : size - n * CHUNK_BYTES;
}

export type ChunkWrite = { ok: true; sha256: Buffer } | { ok: false };

/**
 * Writes `body` at `n × CHUNK_BYTES`. ok only when exactly `expected` bytes arrived; a body that runs long is
 * cancelled at the first byte past `expected` (nothing past it is written), one that ends short or breaks off
 * is not ok. The bytes that did arrive stay in the file: the caller leaves the chunk unreceived, so it must be
 * sent again before `complete`.
 */
export async function writeChunk(
  fh: FileHandle,
  body: ReadableStream<Uint8Array> | null,
  n: number,
  expected: number,
): Promise<ChunkWrite> {
  if (body === null) return { ok: false };
  const base = n * CHUNK_BYTES;
  const hash = createHash('sha256');
  const reader = body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (written + value.byteLength > expected) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      let at = 0;
      while (at < value.byteLength) {
        const { bytesWritten } = await fh.write(value, at, value.byteLength - at, base + written + at);
        at += bytesWritten;
      }
      hash.update(value);
      written += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false };
  }
  return written === expected ? { ok: true, sha256: hash.digest() } : { ok: false };
}
