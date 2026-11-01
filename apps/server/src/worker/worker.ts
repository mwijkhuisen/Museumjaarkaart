import { sql } from 'kysely';
import type pg from 'pg';
import type { Db } from '../db/kysely.ts';
import { HEARTBEAT_EVERY_MS, touch } from '../heartbeat.ts';
import type { Logger } from '../lib/log.ts';
import { type ClaimedJob, claim, complete, fail, LEASE_SECONDS, NOTIFY_CHANNEL, reap } from './queue.ts';
import { JobError, type JobHandler } from './types.ts';

// The worker loop (A§5, plan §2.5): one job at a time. A NOTIFY wakes it; the poll
// is the fallback for backoff times and a lost NOTIFY. Logs carry fixed codes, kinds
// and ids only, never a payload or an error message (invariant 8).

export type RunWorkerOptions = {
  db: Db;
  /** A new, unconnected client for the dedicated LISTEN connection; called again after every loss. */
  listen: () => pg.Client;
  handlers: Readonly<Record<string, JobHandler>>;
  logger: Logger;
  signal: AbortSignal;
  workerId: string;
  pollMs?: number;
  heartbeatPath: string;
  leaseSeconds?: number;
  /** Test seam: the interval of the heartbeat ping while a long job runs. */
  heartbeatMs?: number;
};

const LISTEN_RETRY_FIRST_MS = 1_000;
const LISTEN_RETRY_MAX_MS = 30_000;

/** Resolves after `ms`, or at once when the signal aborts. */
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

/** A wake-up flag: a NOTIFY that arrives while a job runs is not lost. */
function createWaker(signal: AbortSignal) {
  let pending = false;
  let release: (() => void) | undefined;
  return {
    wake() {
      pending = true;
      release?.();
    },
    wait(ms: number): Promise<void> {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          release = undefined;
          pending = false;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        release = done;
      });
    },
  };
}

/** Keeps one LISTEN client alive until the signal aborts; every (re)connect wakes the loop to catch up. */
async function listenLoop(opts: RunWorkerOptions, wake: () => void): Promise<void> {
  const { signal, logger } = opts;
  let retryMs = LISTEN_RETRY_FIRST_MS;
  let down = false;
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  while (!signal.aborted) {
    let client: pg.Client | undefined;
    try {
      client = opts.listen();
      const c = client;
      const lost = new Promise<void>((resolve) => {
        c.once('end', () => resolve());
        c.on('error', () => resolve());
      });
      c.on('notification', (m) => {
        if (m.channel === NOTIFY_CHANNEL) wake();
      });
      await c.connect();
      await c.query(`LISTEN ${NOTIFY_CHANNEL}`); // a constant identifier, never input
      if (down) logger.info({}, 'listen_available');
      down = false;
      retryMs = LISTEN_RETRY_FIRST_MS;
      wake();
      await Promise.race([lost, aborted]);
    } catch {
      // Dropped on purpose: the message can quote the connection.
    }
    if (!down && !signal.aborted) logger.warn({}, 'listen_unavailable');
    down = true;
    try {
      await client?.end();
    } catch {
      // Already gone.
    }
    await sleep(retryMs, signal);
    retryMs = Math.min(retryMs * 2, LISTEN_RETRY_MAX_MS);
  }
}

/** Resolves when `signal` aborts and the current job has finished. */
export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const { db, handlers, logger, signal, workerId } = opts;
  const pollMs = opts.pollMs ?? 30_000;
  const leaseSeconds = opts.leaseSeconds ?? LEASE_SECONDS;
  const waker = createWaker(signal);

  // The database state drives the heartbeat: it is touched only after a round trip that worked,
  // so an outage turns `healthcheck` red and `mjk-tick` restarts the container.
  let down = false;
  const dbOk = () => {
    if (down) logger.info({}, 'db_available');
    down = false;
    try {
      touch(opts.heartbeatPath);
    } catch {
      // A heartbeat that cannot be written shows as unhealthy; the loop goes on.
    }
  };
  const dbFailed = () => {
    if (!down) logger.error({}, 'db_unavailable');
    down = true;
  };

  // While a long job runs there is no claim; this ping keeps the heartbeat fresh.
  let pinging = false;
  const ping = setInterval(async () => {
    if (pinging) return;
    pinging = true;
    try {
      await sql`SELECT 1`.execute(db);
      dbOk();
    } catch {
      dbFailed();
    } finally {
      pinging = false;
    }
  }, opts.heartbeatMs ?? HEARTBEAT_EVERY_MS);
  ping.unref();

  const listener = listenLoop(opts, waker.wake);

  const runJob = async (job: ClaimedJob): Promise<void> => {
    const started = performance.now();
    const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : undefined;
    let code: string | undefined;
    let retry = true;
    if (handler === undefined) {
      code = 'unknown_kind';
      retry = false;
    } else {
      try {
        await handler(job.payload, { signal });
      } catch (err) {
        // Only a JobError's code is kept; anything else is `internal`, never its message.
        code = err instanceof JobError ? err.code : 'internal';
        retry = err instanceof JobError ? err.retry : true;
      }
    }
    try {
      if (code === undefined) {
        if (await complete(db, job, workerId)) {
          logger.info({ kind: job.kind, id: job.id, ms: Math.round(performance.now() - started) }, 'job_done');
        } else {
          logger.warn({ kind: job.kind, id: job.id }, 'job_lease_lost');
        }
      } else {
        const state = await fail(db, job, workerId, code, retry);
        if (state === 'queued') {
          logger.warn({ kind: job.kind, id: job.id, code, attempts: job.attempts }, 'job_retry');
        } else if (state === 'failed') {
          logger.error({ kind: job.kind, id: job.id, code }, 'job_failed');
        } else {
          logger.warn({ kind: job.kind, id: job.id }, 'job_lease_lost');
        }
      }
      dbOk();
    } catch {
      // The row stays `running`; its lease expires and the job is claimed again.
      dbFailed();
      logger.error({ kind: job.kind, id: job.id }, 'job_update_failed');
    }
  };

  try {
    while (!signal.aborted) {
      let job: ClaimedJob | undefined;
      try {
        await reap(db, { leaseSeconds });
        job = await claim(db, workerId, { leaseSeconds });
        dbOk();
      } catch {
        dbFailed();
      }
      if (job !== undefined) {
        await runJob(job);
        continue;
      }
      await waker.wait(pollMs);
    }
  } finally {
    clearInterval(ping);
    await listener;
  }
}
