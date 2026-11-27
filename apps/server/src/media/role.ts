import { constants } from 'node:fs';
import { lstat, open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { HEARTBEAT_PATH, startHeartbeat } from '../heartbeat.ts';
import { createLogger, type Logger } from '../lib/log.ts';
import { MEDIA_WATCHDOG_MS, MEDIA_WORK_DIR, PHOTO_JOB_MS } from './limits.ts';
import { decodeSource } from './process.ts';
import { ABORTED_CODE, TASK, type TaskResult, TaskSpec, variantName } from './task.ts';

// The `media` role (A§12, plan §1 Q1): the only process that decodes an uploaded image. Its container has no
// network, no secret, no database login and one mount, the work directory it shares with the worker. It takes one
// task at a time (the oldest `ready`, renamed to `taken`), decodes `in` and writes flat fixed names, each through
// a temporary name and a rename, `result.json` last. It imports nothing of the database, auth, mail, api or R2.

export type MediaRoleOptions = {
  signal: AbortSignal;
  workDir?: string;
  heartbeatPath?: string;
  logger?: Logger;
  /** Test seams. */
  pollMs?: number;
  budgetMs?: number;
};

const TASK_ID = /^[0-9a-f]{32}$/;
const SPEC_MAX_BYTES = 1024;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

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

/** Takes the oldest task whose `ready` marker exists; the rename is the claim. */
async function takeOldest(workDir: string): Promise<string | undefined> {
  const ready: { dir: string; at: number }[] = [];
  for (const name of await readdir(workDir)) {
    if (!TASK_ID.test(name)) continue;
    const dir = join(workDir, name);
    try {
      const st = await lstat(join(dir, TASK.ready));
      if (st.isFile()) ready.push({ dir, at: st.mtimeMs });
    } catch {
      // Not ready, or gone meanwhile.
    }
  }
  ready.sort((a, b) => a.at - b.at);
  for (const { dir } of ready) {
    try {
      await rename(join(dir, TASK.ready), join(dir, TASK.taken));
      return dir;
    } catch {
      // The worker withdrew it or removed it meanwhile.
    }
  }
  return undefined;
}

async function readSpec(dir: string) {
  try {
    const fh = await open(join(dir, TASK.spec), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(SPEC_MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > SPEC_MAX_BYTES) return undefined;
      const parsed = TaskSpec.safeParse(JSON.parse(buf.subarray(0, bytesRead).toString('utf8')));
      return parsed.success ? parsed.data : undefined;
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/** Writes `name` through a temporary name and a rename, so the worker never sees half a file. */
async function writeAtomic(dir: string, name: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  const fh = await open(tmp, CREATE, 0o600);
  try {
    await fh.writeFile(bytes);
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, name));
}

const writeResult = (dir: string, result: TaskResult) => writeAtomic(dir, TASK.result, JSON.stringify(result));

/** Resolves with the exit code once the signal aborts (SIGTERM): 0. */
export async function runMediaRole(opts: MediaRoleOptions): Promise<number> {
  const { signal } = opts;
  const workDir = opts.workDir ?? MEDIA_WORK_DIR;
  const logger = opts.logger ?? createLogger({ role: 'media' });
  const pollMs = opts.pollMs ?? 500;
  const budgetMs = opts.budgetMs ?? PHOTO_JOB_MS;
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  const runTask = async (dir: string) => {
    const started = Date.now();
    // sharp works off the event loop, so this timer fires even while libvips is stuck; Compose restarts us.
    const watchdog = setTimeout(() => {
      logger.error({}, 'media_watchdog');
      process.exit(1);
    }, MEDIA_WATCHDOG_MS);
    try {
      const spec = await readSpec(dir);
      const outcome =
        spec === undefined
          ? ({ ok: false, code: 'media_decode_failed' } as const)
          : await Promise.race([decodeSource(join(dir, TASK.input), spec.expect, started + budgetMs), aborted]);
      if (outcome === 'aborted') {
        // Retried by the worker; whatever the decoder still finishes is never written.
        await writeResult(dir, { ok: false, code: ABORTED_CODE });
        logger.warn({}, 'media_task_aborted');
        return;
      }
      if (outcome.ok) {
        for (const v of outcome.variants) await writeAtomic(dir, variantName(v.format, v.width), v.bytes);
        const files = outcome.variants.map((v) => ({ format: v.format, width: v.width }));
        await writeResult(dir, { ok: true, width: outcome.width, height: outcome.height, files });
        logger.info({ ms: Date.now() - started }, 'media_task_done');
      } else {
        await writeResult(dir, outcome);
        logger.warn({ code: outcome.code, ms: Date.now() - started }, 'media_task_failed');
      }
    } catch {
      // The worker gave up and removed the task meanwhile, or the mount is full: the worker times out.
      logger.error({}, 'media_task_write_failed');
    } finally {
      clearTimeout(watchdog);
    }
  };

  const stopHeartbeat = startHeartbeat(opts.heartbeatPath ?? HEARTBEAT_PATH);
  let unreadable = false;
  try {
    while (!signal.aborted) {
      let dir: string | undefined;
      try {
        dir = await takeOldest(workDir);
        unreadable = false;
      } catch {
        if (!unreadable) logger.error({}, 'media_workdir_unreadable');
        unreadable = true;
      }
      if (dir === undefined) await sleep(pollMs, signal);
      else await runTask(dir);
    }
  } finally {
    stopHeartbeat();
  }
  return 0;
}
