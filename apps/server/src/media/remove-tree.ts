import { constants } from 'node:fs';
import { type FileHandle, open, readdir, rmdir, unlink } from 'node:fs/promises';

// Removing a tree that another container can change while we walk it (CLAUDE.md "Node's recursive `rm` is not
// safe": it lstats, then reads and descends by path, so a directory swapped for a link in between is followed).
// Quarantine is written by the `api`, media-work by the `media` role, and both are assumed compromised. So every
// directory is opened O_DIRECTORY|O_NOFOLLOW relative to its parent's descriptor (`/proc/self/fd/<fd>/<name>`),
// every entry is unlinked through that descriptor, and a name is never resolved through a link.

const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/**
 * One descriptor stays open per level. A deeper part is left where it is (never removed by path); with media-work
 * a 256 MB tmpfs and quarantine the api's, what is left is bounded, and the next sweep tries again.
 */
const MAX_DEPTH = 256;
/** A directory that is refilled while we empty it is tried this often, then left for the next sweep. */
const ROUNDS = 3;

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/** Empties the directory behind `fd`: links and files are unlinked, directories emptied the same way and removed. */
export async function emptyDir(fd: number, depth = 0): Promise<void> {
  const base = `/proc/self/fd/${fd}`;
  for (const name of await readdir(base)) {
    const path = `${base}/${name}`;
    try {
      await unlink(path);
      continue;
    } catch (err) {
      if (code(err) !== 'EISDIR' || depth >= MAX_DEPTH) continue;
    }
    let sub: FileHandle;
    try {
      sub = await open(path, DIR);
    } catch {
      continue; // swapped for a link or gone meanwhile: the next round unlinks it
    }
    try {
      await emptyDir(sub.fd, depth + 1);
    } catch {
      // unreadable meanwhile: left for the next sweep
    } finally {
      await sub.close();
    }
    await rmdir(path).catch(() => {});
  }
}

/**
 * Removes `path` and everything below it without following a link anywhere: a link or file at `path` is
 * unlinked, a directory is emptied through its descriptor and removed. A missing path is fine; whatever cannot be
 * removed safely is left in place.
 */
export async function removeTree(path: string): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    let dir: FileHandle;
    try {
      dir = await open(path, DIR);
    } catch (err) {
      const c = code(err);
      if (c === 'ENOENT') return;
      // ENOTDIR (a file) or ELOOP (a link): the name itself goes, its target is never touched.
      if (c === 'ENOTDIR' || c === 'ELOOP') await unlink(path).catch(() => {});
      return;
    }
    try {
      await emptyDir(dir.fd);
    } catch {
      // unreadable: rmdir below fails and the next sweep tries again
    } finally {
      await dir.close();
    }
    try {
      await rmdir(path);
      return;
    } catch (err) {
      const c = code(err);
      if (c === 'ENOENT') return;
      if (c === 'ENOTDIR') {
        await unlink(path).catch(() => {}); // swapped for a link after we emptied it
        return;
      }
      if (c !== 'ENOTEMPTY' && c !== 'EEXIST') return;
    }
  }
}
