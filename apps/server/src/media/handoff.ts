import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { JobError } from '../worker/types.ts';
import { MEDIA_WORK_DIR, PHOTO_JOB_MS, TAKE_MS, variantWidths } from './limits.ts';
import { emptyDir, removeTree } from './remove-tree.ts';
import { ABORTED_CODE, TASK, TaskResult, variantName } from './task.ts';
import type { Decode, Decoded, Variant } from './types.ts';
import { checkVariant, expectedHeight } from './variant-check.ts';

// The worker's side of the handoff to the `media` role (A§12, A§16.2 "Compromised worker"; plan §2 "Processing").
// The decoder is assumed compromised: it may plant links, swap files or rename the task directory. So the worker
// opens the task directory once (O_NOFOLLOW) and reaches every file through that descriptor
// (`/proc/self/fd/<dirfd>/<fixed name>`, O_NOFOLLOW), reads each file once into memory, validates the buffer and
// never opens a path again. The task is removed through the same descriptor, never by following a link.

export type HandoffSeams = { workDir?: string; takeMs?: number; jobMs?: number; pollMs?: number };

const RESULT_MAX_BYTES = 64 * 1024;
const VARIANT_MAX_BYTES = 16 * 1024 * 1024;
const WITHDRAWN = 'withdrawn';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = constants;
const CREATE = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
/** O_NONBLOCK: a planted FIFO must not block the open; it is refused by the fstat check. */
const READ = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

const badOutput = () => new JobError('media_bad_output', { retry: false });

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return false;
    throw err;
  }
}

async function writeNew(path: string, data: string): Promise<void> {
  const fh = await open(path, CREATE, 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** Copies the source (never through a link) into a new file. */
async function copyIn(source: string, target: string): Promise<void> {
  const src = await open(source, O_RDONLY | O_NOFOLLOW);
  try {
    const dst = await open(target, CREATE, 0o600);
    try {
      for await (const chunk of src.createReadStream({ autoClose: false, start: 0 })) await dst.write(chunk as Buffer);
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
}

/** Reads a regular file of 1 to `max` bytes once, through a descriptor of our own. Any doubt is bad output. */
async function readOnce(path: string, max: number): Promise<Buffer> {
  let fh: FileHandle;
  try {
    fh = await open(path, READ);
  } catch {
    throw badOutput();
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 1 || st.size > max) throw badOutput();
    const buf = Buffer.alloc(st.size + 1);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off !== st.size) throw badOutput(); // changed while we read it
    return buf.subarray(0, off);
  } catch (err) {
    throw err instanceof JobError ? err : badOutput();
  } finally {
    await fh.close();
  }
}

/** Reads and validates the role's answer. A decode failure is the role's fixed code. */
async function readBack(at: (name: string) => string): Promise<Decoded> {
  let result: TaskResult;
  try {
    result = TaskResult.parse(JSON.parse((await readOnce(at(TASK.result), RESULT_MAX_BYTES)).toString('utf8')));
  } catch {
    throw badOutput();
  }
  if (!result.ok) throw new JobError(result.code, { retry: result.code === ABORTED_CODE });

  const want = variantWidths(result.width).flatMap((w) => [variantName('avif', w), variantName('webp', w)]);
  const got = result.files.map((f) => variantName(f.format, f.width));
  if (got.length !== want.length || want.some((n) => !got.includes(n))) throw badOutput();

  const variants: Variant[] = [];
  for (const f of result.files) {
    const bytes = await readOnce(at(variantName(f.format, f.width)), VARIANT_MAX_BYTES);
    // The whole container, not only its magic bytes: no metadata chunk or item, and the size the widths and the
    // source aspect give (P3b security review M2).
    if (!checkVariant(bytes, f.format, f.width, expectedHeight(result.width, result.height, f.width))) {
      throw badOutput();
    }
    variants.push({ format: f.format, width: f.width, bytes });
  }
  return { width: result.width, height: result.height, variants };
}

/** Removes the task: its content through the descriptor we opened, then whatever the name now holds. */
async function removeTask(path: string, dir: FileHandle | undefined): Promise<void> {
  if (dir !== undefined) {
    await emptyDir(dir.fd).catch(() => {});
    await dir.close();
  }
  // A link the decoder put there is unlinked; a directory it renamed into place is removed the same way.
  await removeTree(path);
}

/** The worker's Decode (media/types.ts) against the `media` role on the shared work directory. */
export function createDecode(seams: HandoffSeams = {}): Decode {
  const workDir = seams.workDir ?? MEDIA_WORK_DIR;
  const takeMs = seams.takeMs ?? TAKE_MS;
  const jobMs = seams.jobMs ?? PHOTO_JOB_MS;
  const pollMs = seams.pollMs ?? 250;

  return async (source, signal) => {
    const path = join(workDir, randomBytes(16).toString('hex'));
    await mkdir(path, { mode: 0o700 });
    let dir: FileHandle | undefined;
    try {
      dir = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      const fd = dir.fd;
      const at = (name: string) => `/proc/self/fd/${fd}/${name}`;
      await copyIn(source.path, at(TASK.input));
      await writeNew(at(TASK.spec), JSON.stringify({ expect: source.expect }));
      await writeNew(at(TASK.ready), '');

      // Taken when `ready` is gone. At the deadline the worker withdraws it with a rename, so a late take and
      // the give-up never both win.
      const offered = Date.now();
      while (await exists(at(TASK.ready))) {
        if (signal.aborted) throw new JobError(ABORTED_CODE);
        if (Date.now() - offered >= takeMs) {
          const withdrawn = await rename(at(TASK.ready), at(WITHDRAWN)).then(
            () => true,
            (err: unknown) => {
              if (errCode(err) === 'ENOENT') return false; // taken just now
              throw err;
            },
          );
          if (withdrawn) throw new JobError('media_not_taken');
          break;
        }
        await sleep(pollMs, signal);
      }

      const taken = Date.now();
      while (!(await exists(at(TASK.result)))) {
        if (signal.aborted) throw new JobError(ABORTED_CODE);
        if (Date.now() - taken >= jobMs) throw new JobError('media_timeout', { retry: false });
        await sleep(pollMs, signal);
      }
      return await readBack(at);
    } finally {
      await removeTask(path, dir);
    }
  };
}
