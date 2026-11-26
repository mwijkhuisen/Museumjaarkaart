import { open } from 'node:fs/promises';
import { NL_BOX } from '@mjk/contracts';

// The check of an extract before any upload (A§15.3). go-pmtiles 1.31.2 follows redirects to any host and has
// no resume, so what it left on disk is data: a regular file with a PMTiles v3 header (127 bytes), vector
// tiles the browser can decompress, zooms from 0, bounds inside the national box and a size between a floor
// and a ceiling. The result is a fixed reason (logged with `tiles_bad_file`), or null.

const MIB = 1024 * 1024;
export const HEADER_BYTES = 127;
/** The slack of the bounds, in degrees (go-pmtiles rounds them to 1e-7). */
export const BOUNDS_SLACK = 0.01;

export type TileLimits = {
  /** A truncated file or an error page is far below it; the NL extract at the build's full zoom range is [U] ~1–2 GB (A§15.3). */
  minBytes: number;
  /** Twice the upper estimate; `fsize` in deploy/compose.yaml sits just above it, so a runaway extract stops there. */
  maxBytes: number;
  box: { latMin: number; latMax: number; lonMin: number; lonMax: number };
};

export const TILE_LIMITS: TileLimits = { minBytes: 100 * MIB, maxBytes: 4096 * MIB, box: NL_BOX };

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;
const TYPE_MVT = 1;

/**
 * Why `path` may not be uploaded, as a fixed reason, or null. Reasons: `not_file`, `size`, `magic`, `version`,
 * `type`, `compression`, `zoom`, `bounds`, `truncated`.
 */
export async function tilesProblem(path: string, limits: TileLimits = TILE_LIMITS): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'r');
  } catch {
    return 'not_file';
  }
  try {
    const { size, isFile } = await file.stat().then((s) => ({ size: s.size, isFile: s.isFile() }));
    if (!isFile) return 'not_file';
    if (size < limits.minBytes || size > limits.maxBytes) return 'size';
    const h = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await file.read(h, 0, HEADER_BYTES, 0);
    if (bytesRead !== HEADER_BYTES || h.toString('latin1', 0, 7) !== 'PMTiles') return 'magic';
    if (h[7] !== 3) return 'version';
    if (h[99] !== TYPE_MVT) return 'type';
    if (h[98] !== COMPRESSION_NONE && h[98] !== COMPRESSION_GZIP) return 'compression';
    const [minZoom, maxZoom] = [h.readUInt8(100), h.readUInt8(101)];
    if (minZoom !== 0 || maxZoom < minZoom) return 'zoom';
    const deg = (at: number) => h.readInt32LE(at) / 1e7;
    const [w, s, e, n] = [deg(102), deg(106), deg(110), deg(114)];
    const b = limits.box;
    if (
      !(w < e && s < n) ||
      w < b.lonMin - BOUNDS_SLACK ||
      e > b.lonMax + BOUNDS_SLACK ||
      s < b.latMin - BOUNDS_SLACK ||
      n > b.latMax + BOUNDS_SLACK
    ) {
      return 'bounds';
    }
    // Root directory, metadata, leaf directories and tile data: offset and length pairs at 8, 24, 40 and 56.
    for (const at of [8, 24, 40, 56]) {
      if (h.readBigUInt64LE(at) + h.readBigUInt64LE(at + 8) > BigInt(size)) return 'truncated';
    }
    return null;
  } catch {
    return 'not_file';
  } finally {
    await file.close().catch(() => {});
  }
}
