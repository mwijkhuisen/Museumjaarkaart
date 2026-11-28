import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { variantsDir } from './files.ts';
import { checkVariant, expectedHeight } from './variant-check.ts';

// The author's preview of a photo that waits for review (A§12, A§14): the one place a reader gets a byte out of
// quarantine, and only a WebP variant that our own worker wrote there. The file is opened without following a
// link, must be a regular file under a size cap, is read once into memory and has its container checked before
// any byte leaves. No route reads the originals (`/srv/mjk/originals` is not mounted in the api, A§17.1).

/** A WebP at 1,200 px is a few hundred kB; 8 MiB is far above any variant and far below a memory problem. */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

const WEBP_NAME = /^([0-9]{1,4})\.webp$/;

/** The largest of `widths` that is at most `w`, else the smallest; undefined for none. */
export function pickWidth(widths: readonly number[], w: number): number | undefined {
  const sorted = [...widths].sort((a, b) => a - b);
  return sorted.filter((x) => x <= w).at(-1) ?? sorted[0];
}

/**
 * The WebP variant of this photo for a requested width, or undefined when there is none or it is not sound: its
 * whole container must be sharp's at the photo's size (media/variant-check.ts), not only its magic bytes.
 */
export async function readPreview(
  root: string,
  photo: { id: string; width: number | null; height: number | null },
  w: number,
): Promise<Buffer | undefined> {
  if (photo.width === null || photo.height === null) return undefined;
  const dir = variantsDir(root, photo.id);
  let names: string[];
  try {
    // A link in place of the directory is refused: the directory is ours (mkdir by the worker), never a link.
    if (!(await lstat(dir)).isDirectory()) return undefined;
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const widths = names.flatMap((n) => {
    const m = WEBP_NAME.exec(n);
    return m === null ? [] : [Number(m[1])];
  });
  const width = pickWidth(widths, w);
  if (width === undefined) return undefined;
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(join(dir, `${width}.webp`), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 1 || st.size > PREVIEW_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(bytes, 0, st.size, 0);
    if (bytesRead !== st.size) return undefined;
    return checkVariant(bytes, 'webp', width, expectedHeight(photo.width, photo.height, width)) ? bytes : undefined;
  } finally {
    await fh.close();
  }
}
