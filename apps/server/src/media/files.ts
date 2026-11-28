import { constants } from 'node:fs';
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { removeTree } from './remove-tree.ts';

// Quarantine paths (A§12, A§17.1: `/srv/mjk/quarantine/<id>/upload`, variants in `<id>/v/`). The id is a
// server uuid, checked again here before it touches a path; files are opened without following a link in the
// last component, and every directory below the mount is ours (made with mkdir, never taken from a request).
// The mount is 63532 0700 on the host, shared by `api` and `worker` only (the `media` role never sees it).

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checked(id: string): string {
  if (!ID.test(id)) throw new Error('media: invalid id');
  return id;
}

export const uploadDir = (root: string, id: string): string => join(root, checked(id));
export const uploadPath = (root: string, id: string): string => join(uploadDir(root, id), 'upload');
export const variantsDir = (root: string, id: string): string => join(uploadDir(root, id), 'v');

/** A new upload's directory (0700) and empty file (0600); fails if either exists. */
export async function createUploadFile(root: string, id: string): Promise<void> {
  await mkdir(uploadDir(root, id), { mode: 0o700 });
  const fh = await open(
    uploadPath(root, id),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  await fh.close();
}

/** The upload file, for positional writes (`O_WRONLY`) or for reading (`O_RDONLY`); never through a link. */
export const openUpload = (root: string, id: string, mode: 'read' | 'write'): Promise<FileHandle> =>
  open(uploadPath(root, id), (mode === 'write' ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW);

/** Removes an upload's directory and everything in it through descriptors; a link is removed, never followed. */
export const removeUpload = (root: string, id: string): Promise<void> => removeTree(uploadDir(root, id));

const busy = new Set<string>();

/**
 * Runs `fn` while no other request of this process works on the same upload: a chunk PUT, `complete` and
 * `DELETE` never overlap. Returns undefined, without running `fn`, when the upload is busy.
 * ponytail: an in-process lock, because the `api` is one process (A§5); a database lock if it ever scales out.
 */
export async function withUploadLock<T>(id: string, fn: () => Promise<T>): Promise<{ value: T } | undefined> {
  if (busy.has(id)) return undefined;
  busy.add(id);
  try {
    return { value: await fn() };
  } finally {
    busy.delete(id);
  }
}
