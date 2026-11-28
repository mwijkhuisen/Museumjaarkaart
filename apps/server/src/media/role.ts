import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HEARTBEAT_PATH, startHeartbeat } from '../heartbeat.ts';
import { createLogger, type Logger } from '../lib/log.ts';
import { MEDIA_WATCHDOG_MS, MEDIA_WORK_DIR, PHOTO_JOB_MS } from './limits.ts';
import { removeTree } from './remove-tree.ts';
import { ABORTED_CODE, DECODE_CODES, TASK, TaskSpec, writeResult } from './task.ts';
import type { SourceFormat } from './types.ts';

// The `media` role (A§12, plan §1 Q1): the only process that decodes an uploaded image. Its container has no
// network, no secret, no database login and one mount, the work directory it shares with the worker. It takes one
// task at a time (the oldest `ready`, renamed to `taken`) and hands it to a single-use child (media/task-child.ts),
// which decodes `in` and writes flat fixed names, each through a temporary name and a rename, `result.json` last.
// After every task the child's process group is killed, every other process of the container too, and /tmp is
// wiped but for the heartbeat, so a decoder that one photo compromised keeps nothing for the next member's photo
// (P3b security review M2 b). The role itself never loads sharp. It imports nothing of the database, auth, mail,
// api or R2.

export type MediaRoleOptions = {
  signal: AbortSignal;
  workDir?: string;
  heartbeatPath?: string;
  logger?: Logger;
  /**
   * In the container (main.ts): its /tmp, wiped after every task but for the heartbeat, and its PID namespace, whose
   * every other process is killed after every task. Never set in tests: they share the host's /tmp and /proc.
   */
  container?: { tmpDir: string; procDir: string };
  /** Test seams. */
  pollMs?: number;
  budgetMs?: number;
  watchdogMs?: number;
  /** Extra environment for the child (a test's TMPDIR). */
  childEnv?: Record<string, string>;
};

const TASK_ID = /^[0-9a-f]{32}$/;
const SPEC_MAX_BYTES = 1024;

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

const CHILD = new URL('./task-child.ts', import.meta.url);
const REPORTED = new Set<string>(['done', ...DECODE_CODES]);

type ChildEnd =
  | { kind: 'reported'; code: string; maxRssKiB: number }
  | { kind: 'crashed'; exit: number | null; sig: string | null }
  | { kind: 'aborted' }
  | { kind: 'watchdog' };

/** SIGKILL to a process group; it may be gone already. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: nothing left.
  }
}

/**
 * Kills every process in `procDir` but this one (and PID 1 when that is not us): in the container's PID namespace
 * that is whatever a compromised decoder left running, even outside its process group (a `docker exec` or a
 * healthcheck that runs just then goes too; the next healthcheck is a new process). Only when this process owns
 * the namespace (it is PID 1: the `media` service has no init), so it can never reach a host's processes.
 * Returns how many.
 */
export async function killStrays(procDir: string, ownsNamespace = process.pid === 1): Promise<number> {
  if (!ownsNamespace) return 0;
  let n = 0;
  for (const name of await readdir(procDir).catch(() => [] as string[])) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid || pid === 1) continue;
    try {
      process.kill(pid, 'SIGKILL');
      n++;
    } catch {
      // gone meanwhile, or not ours
    }
  }
  return n;
}

/** Empties `tmpDir` through descriptors, but for the heartbeat file. */
async function wipeTmp(tmpDir: string, heartbeatPath: string): Promise<void> {
  const keep = dirname(heartbeatPath) === tmpDir ? basename(heartbeatPath) : undefined;
  for (const name of await readdir(tmpDir).catch(() => [] as string[])) {
    if (name !== keep) await removeTree(join(tmpDir, name));
  }
}

/** Resolves with the exit code once the signal aborts (SIGTERM): 0. */
export async function runMediaRole(opts: MediaRoleOptions): Promise<number> {
  const { signal } = opts;
  const workDir = opts.workDir ?? MEDIA_WORK_DIR;
  const logger = opts.logger ?? createLogger({ role: 'media' });
  const pollMs = opts.pollMs ?? 500;
  const budgetMs = opts.budgetMs ?? PHOTO_JOB_MS;

  const watchdogMs = opts.watchdogMs ?? MEDIA_WATCHDOG_MS;
  const heartbeatPath = opts.heartbeatPath ?? HEARTBEAT_PATH;
  const childEnv = {
    ...process.env,
    ...(opts.container === undefined ? {} : { TMPDIR: opts.container.tmpDir }),
    ...opts.childEnv,
  };

  /** One task in a fresh child: its end, whichever comes first. */
  const runChild = (dir: string, expect: SourceFormat, deadlineMs: number) =>
    new Promise<ChildEnd>((resolve) => {
      const child = fork(CHILD, [], {
        execArgv: [],
        env: childEnv,
        // Its own process group (setsid), so the group kill takes whatever it forked; no output of its own.
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let report: { code: string; maxRssKiB: number } | undefined;
      let ended = false;
      const end = (e: ChildEnd) => {
        killGroup(child.pid);
        if (ended) return;
        ended = true;
        clearTimeout(watchdog);
        signal.removeEventListener('abort', onAbort);
        resolve(e);
      };
      // The child works off our event loop, so this fires even while libvips is stuck; the role stays up.
      const watchdog = setTimeout(() => end({ kind: 'watchdog' }), watchdogMs);
      const onAbort = () => end({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      child.on('message', (m: unknown) => {
        // The child is the untrusted party: only a fixed code and a number are kept.
        const r = m as { code?: unknown; maxRssKiB?: unknown } | null;
        if (typeof r?.code === 'string' && REPORTED.has(r.code) && Number.isSafeInteger(r.maxRssKiB))
          report = { code: r.code, maxRssKiB: r.maxRssKiB as number };
      });
      child.on('error', () => end({ kind: 'crashed', exit: null, sig: null }));
      // 'close', not 'exit': Node guarantees only that 'close' comes after the IPC channel is drained, so the
      // report is in by then. A child that leaves a holder of the channel behind ends at the watchdog.
      child.on('close', (exit, sig) =>
        end(exit === 0 && report !== undefined ? { kind: 'reported', ...report } : { kind: 'crashed', exit, sig }),
      );
      child.send({ dir, expect, deadlineMs });
    });

  const runTask = async (dir: string) => {
    const started = Date.now();
    try {
      const spec = await readSpec(dir);
      if (spec === undefined) {
        await writeResult(dir, { ok: false, code: 'media_decode_failed' });
        logger.warn({ code: 'media_decode_failed', ms: 0 }, 'media_task_failed');
        return;
      }
      const e = await runChild(dir, spec.expect, started + budgetMs);
      const ms = Date.now() - started;
      if (e.kind === 'aborted') {
        // Retried by the worker; the child is gone, so nothing it would still finish is written.
        await writeResult(dir, { ok: false, code: ABORTED_CODE });
        logger.warn({}, 'media_task_aborted');
      } else if (e.kind === 'watchdog') {
        logger.error({ ms }, 'media_watchdog');
      } else if (e.kind === 'crashed') {
        // Killed (fsize, memory) or broken: the worker gets a fixed failure instead of waiting for its timeout.
        await writeResult(dir, { ok: false, code: 'media_decode_failed' });
        logger.error({ exit: e.exit, sig: e.sig, ms }, 'media_task_crashed');
      } else if (e.code === 'done') {
        logger.info({ ms, rss_kib: e.maxRssKiB }, 'media_task_done');
      } else {
        logger.warn({ code: e.code, ms, rss_kib: e.maxRssKiB }, 'media_task_failed');
      }
    } catch {
      // The worker gave up and removed the task meanwhile, or the mount is full: the worker times out.
      logger.error({}, 'media_task_write_failed');
    } finally {
      if (opts.container !== undefined) {
        await killStrays(opts.container.procDir);
        await wipeTmp(opts.container.tmpDir, heartbeatPath);
      }
    }
  };

  const stopHeartbeat = startHeartbeat(heartbeatPath);
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
