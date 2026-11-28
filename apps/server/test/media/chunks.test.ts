import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_BYTES } from '@mjk/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chunkLength, writeChunk } from '../../src/media/chunks.ts';

// One chunk of an upload (A§12; code review M3): the exact lengths, and a body that runs long is refused at its
// first extra byte with nothing written past the chunk's range.

const MiB = 1024 * 1024;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mjk-chunks-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const count = (size: number) => Math.ceil(size / CHUNK_BYTES);
const lengths = (size: number) => Array.from({ length: count(size) }, (_, n) => chunkLength(size, count(size), n));

const streamOf = (...pieces: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const p of pieces) ctl.enqueue(p);
      ctl.close();
    },
  });

it('chunkLength: 8 MiB chunks, the last one the remainder', () => {
  expect(CHUNK_BYTES).toBe(8 * MiB);
  expect(lengths(1)).toEqual([1]);
  expect(lengths(8 * MiB)).toEqual([8 * MiB]);
  expect(lengths(8 * MiB + 1)).toEqual([8 * MiB, 1]);
  expect(lengths(25 * MiB)).toEqual([8 * MiB, 8 * MiB, 8 * MiB, MiB]);
});

it('writeChunk writes exactly the expected bytes at n × 8 MiB and returns their sha256', async () => {
  const path = join(dir, 'exact');
  const fh = await open(path, 'w+');
  try {
    const body = new Uint8Array(1000).fill(7);
    const r = await writeChunk(fh, streamOf(body.subarray(0, 300), body.subarray(300)), 1, 1000);
    expect(r).toEqual({ ok: true, sha256: createHash('sha256').update(body).digest() });
    expect((await stat(path)).size).toBe(CHUNK_BYTES + 1000);
  } finally {
    await fh.close();
  }
});

it('writeChunk refuses a body that runs long: the first piece is written, nothing past the range', async () => {
  const path = join(dir, 'long');
  const fh = await open(path, 'w+');
  try {
    // The next chunk's first bytes, which an overflow would overwrite.
    await fh.write(new Uint8Array(16).fill(0xaa), 0, 16, 1000);
    const r = await writeChunk(fh, streamOf(new Uint8Array(600).fill(1), new Uint8Array(600).fill(2)), 0, 1000);
    expect(r).toEqual({ ok: false });
  } finally {
    await fh.close();
  }
  const bytes = await readFile(path);
  expect(bytes.length).toBe(1016);
  expect(bytes.subarray(0, 600).every((b) => b === 1)).toBe(true);
  expect(bytes.subarray(600, 1000).every((b) => b === 0)).toBe(true);
  expect(bytes.subarray(1000).every((b) => b === 0xaa)).toBe(true);
});

it('writeChunk refuses a short body and a missing one', async () => {
  const fh = await open(join(dir, 'short'), 'w+');
  try {
    expect(await writeChunk(fh, streamOf(new Uint8Array(999)), 0, 1000)).toEqual({ ok: false });
    expect(await writeChunk(fh, null, 0, 1000)).toEqual({ ok: false });
  } finally {
    await fh.close();
  }
});
