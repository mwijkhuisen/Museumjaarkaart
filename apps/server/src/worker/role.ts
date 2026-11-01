import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb } from '../db/kysely.ts';
import { dbUrl, EXIT_CONFIG } from '../db/migrate.ts';
import { createPool, WORKER_POOL_MAX } from '../db/pool.ts';
import { HEARTBEAT_PATH } from '../heartbeat.ts';
import type { Logger } from '../lib/log.ts';
import { startSchedule } from './schedule.ts';
import type { JobHandler } from './types.ts';
import { runWorker } from './worker.ts';

// The `worker` role (A§5), called by main.ts: the pool and LISTEN client as mjk_worker,
// the weekly schedule, then the loop until the signal aborts.

type Env = Readonly<Record<string, string | undefined>>;

export async function runWorkerRole(
  env: Env,
  opts: {
    handlers: Readonly<Record<string, JobHandler>>;
    logger: Logger;
    signal: AbortSignal;
    heartbeatPath?: string;
  },
): Promise<number> {
  const { logger } = opts;
  const pool = createPool('mjk_worker', env, { max: WORKER_POOL_MAX });
  const url = dbUrl('mjk_worker', env);
  if (typeof pool === 'string' || typeof url === 'string') {
    // The text names the secret file, never its content; only the fixed code is logged.
    if (typeof pool !== 'string') await pool.end();
    logger.error({}, 'config_invalid');
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  const schedule = startSchedule({ db, logger });
  try {
    await runWorker({
      db,
      listen: () => new pg.Client({ connectionString: url.href, application_name: 'mjk_worker' }),
      handlers: opts.handlers,
      logger,
      signal: opts.signal,
      workerId: `worker-${process.pid}-${randomBytes(3).toString('hex')}`,
      heartbeatPath: opts.heartbeatPath ?? HEARTBEAT_PATH,
    });
  } finally {
    schedule.stop();
    await db.destroy();
  }
  return 0;
}
