import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../db/kysely.ts';
import { dbUrl, EXIT_CONFIG } from '../db/migrate.ts';
import { createPool, WORKER_POOL_MAX } from '../db/pool.ts';
import { HEARTBEAT_PATH } from '../heartbeat.ts';
import { createPinger, type Pinger } from '../lib/healthchecks.ts';
import type { Logger } from '../lib/log.ts';
import { MEDIA_WORK_DIR, QUARANTINE_DIR } from '../media/limits.ts';
import { EXPORTS_DIR } from '../passport/export/files.ts';
import { startHealthPing } from './health-ping.ts';
import { startSchedule } from './schedule.ts';
import type { JobHandler } from './types.ts';
import { runWorker } from './worker.ts';

// The `worker` role (A§5), called by main.ts: the pool and LISTEN client as mjk_worker,
// the weekly schedule, then the loop until the signal aborts.

type Env = Readonly<Record<string, string | undefined>>;

export async function runWorkerRole(
  env: Env,
  opts: {
    /** The handlers, or a function that builds them on the role's database. */
    handlers: Readonly<Record<string, JobHandler>> | ((db: Db) => Readonly<Record<string, JobHandler>>);
    logger: Logger;
    signal: AbortSignal;
    heartbeatPath?: string;
    /** Test seam: the healthchecks pinger (default: the one made from the `hc_ping_key` file secret). */
    pinger?: Pinger;
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
  const schedule = startSchedule({
    db,
    logger,
    exportsDir: EXPORTS_DIR,
    quarantineDir: QUARANTINE_DIR,
    mediaWorkDir: MEDIA_WORK_DIR,
  });
  const healthPing = startHealthPing({ db, logger, env, pinger: opts.pinger ?? createPinger({ logger }) });
  try {
    await runWorker({
      db,
      listen: () => new pg.Client({ connectionString: url.href, application_name: 'mjk_worker' }),
      handlers: typeof opts.handlers === 'function' ? opts.handlers(db) : opts.handlers,
      logger,
      signal: opts.signal,
      workerId: `worker-${process.pid}-${randomBytes(3).toString('hex')}`,
      heartbeatPath: opts.heartbeatPath ?? HEARTBEAT_PATH,
    });
  } finally {
    schedule.stop();
    healthPing.stop();
    await db.destroy();
  }
  return 0;
}
