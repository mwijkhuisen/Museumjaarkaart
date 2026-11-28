import { nodeIo, runAdmin } from './admin/cli.ts';
import { runApi } from './api/server.ts';
import { readAppKeys } from './auth/keys.ts';
import { type BackupDeps, runBackup } from './backup/run.ts';
import { createDb } from './db/kysely.ts';
import { EXIT_CONFIG, runMigrate } from './db/migrate.ts';
import { createPool, WORKER_POOL_MAX } from './db/pool.ts';
import { HEARTBEAT_PATH, healthy } from './heartbeat.ts';
import { createLogger } from './lib/log.ts';
import { lettermintMailer } from './mail/lettermint.ts';
import { createDecode } from './media/handoff.ts';
import { QUARANTINE_DIR } from './media/limits.ts';
import { mediaProcessJob } from './media/process-job.ts';
import { mediaPublishJob } from './media/publish.ts';
import { mediaDeleteJob } from './media/remove.ts';
import { MEDIA_DELETE_JOB, MEDIA_PROCESS_JOB, MEDIA_PUBLISH_JOB } from './media/types.ts';
import { commonsImageJob } from './museums/commons/image-job.ts';
import { COMMONS_IMAGE_JOB, COMMONS_SYNC_JOB } from './museums/commons/store.ts';
import { commonsSyncJob } from './museums/commons/sync-job.ts';
import type { Source } from './museums/fields.ts';
import { type Fetchers, runSync, type SyncResult } from './museums/sync.ts';
import { liveFetchers, MUSEUM_SYNC_JOB, museumSyncJob } from './museums/sync-job.ts';
import { EXPORTS_DIR } from './passport/export/files.ts';
import { DATA_EXPORT_JOB, dataExportJob } from './passport/export/job.ts';
import { STATS_RECOMPUTE_JOB, statsRecomputeJob } from './reviews/stats-job.ts';
import { runSsr } from './ssr/server.ts';
import { TILES_REFRESH_JOB, TILES_ROLLBACK_JOB, tilesRefreshJob, tilesRollbackJob } from './tiles/job.ts';
import { mailJobs } from './worker/mail.ts';
import { runWorkerRole } from './worker/role.ts';

/** Roles of the single server image (A§5); the first argument picks one. */
export const ROLES = [
  'api',
  'ssr',
  'worker',
  'media',
  'migrate',
  'healthcheck',
  'sync-museums',
  'admin',
  'backup',
] as const;
export type Role = (typeof ROLES)[number];

/** A role its phase has not built yet, a missing role and an unknown role. */
export const EXIT_NOT_BUILT = 2;
/** Bad arguments to a role. */
export const EXIT_USAGE = 64;
/** sync-museums: the empty guard, the mass-change brake or the wrong mode for the table refused the run. */
export const EXIT_REFUSED = 65;
/** sync-museums: the transaction failed. */
export const EXIT_SOFTWARE = 70;
/** sync-museums: Wikidata or RCE could not be fetched. */
export const EXIT_UNAVAILABLE = 69;
/** sync-museums: another run holds the lock. */
export const EXIT_TEMPFAIL = 75;
export { EXIT_CONFIG };

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = `usage: main.ts <${ROLES.join('|')}> [args]`;
const SYNC_USAGE = 'usage: main.ts sync-museums [--dry-run] [--seed] [--accept-drop wikidata|rce] [--accept-changes]';

/** Test seams: where lines go, the heartbeat file, the sources, the signal that stops a daemon, the api's port. */
export type RunDeps = {
  out?: (line: string) => void;
  fetchers?: Fetchers;
  signal?: AbortSignal;
  port?: number;
  hostname?: string;
  onListening?: (port: number) => void;
  /** The backup role's paths and tool binaries (tests). */
  backup?: BackupDeps;
  /** The file secrets' directory (`app_keys`, the Lettermint token); `/run/secrets` in production. */
  secretsDir?: string;
};

/** The signal that stops a daemon: the test's, or SIGTERM and SIGINT. */
function stopSignal(deps: RunDeps): AbortSignal {
  if (deps.signal !== undefined) return deps.signal;
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  return stop.signal;
}

type SyncArgs = { dryRun: boolean; seed: boolean; acceptDrop: Source | null; acceptChanges: boolean };

export function parseSyncArgs(args: readonly string[]): SyncArgs | undefined {
  const parsed: SyncArgs = { dryRun: false, seed: false, acceptDrop: null, acceptChanges: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run' && !parsed.dryRun) parsed.dryRun = true;
    else if (a === '--seed' && !parsed.seed) parsed.seed = true;
    else if (a === '--accept-changes' && !parsed.acceptChanges) parsed.acceptChanges = true;
    else if (a === '--accept-drop' && parsed.acceptDrop === null) {
      const source = args[++i];
      if (source !== 'wikidata' && source !== 'rce') return undefined;
      parsed.acceptDrop = source;
    } else return undefined;
  }
  return parsed;
}

const syncExit = (r: SyncResult): number => {
  if (r.outcome === 'applied' || r.outcome === 'dry_run') return 0;
  if (r.outcome === 'refused') return EXIT_REFUSED;
  if (r.code === 'sync_busy') return EXIT_TEMPFAIL;
  if (r.code === 'wikidata_unavailable' || r.code === 'rce_unavailable') return EXIT_UNAVAILABLE;
  return EXIT_SOFTWARE;
};

/** One-off import or diff (A§5), the worker's weekly code, as mjk_worker. Prints the summary: counts and codes only. */
async function runSyncRole(args: readonly string[], env: Env, log: (line: string) => void, deps: RunDeps) {
  const parsed = parseSyncArgs(args);
  if (parsed === undefined) {
    log(SYNC_USAGE);
    return EXIT_USAGE;
  }
  const pool = createPool('mjk_worker', env, { max: WORKER_POOL_MAX });
  if (typeof pool === 'string') {
    log('sync-museums: the database configuration is missing or invalid');
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  try {
    const r = await runSync(db, deps.fetchers ?? liveFetchers(env), createLogger({ role: 'sync-museums' }), {
      mode: parsed.seed ? 'seed' : 'sync',
      dryRun: parsed.dryRun,
      acceptDrop: parsed.acceptDrop,
      acceptChanges: parsed.acceptChanges,
    });
    (deps.out ?? console.log)(JSON.stringify(r.summary, null, 2));
    return syncExit(r);
  } finally {
    await db.destroy();
  }
}

/** The worker daemon (A§5): runs until SIGTERM or SIGINT, then finishes its current job. */
async function runWorker(env: Env, heartbeatPath: string, deps: RunDeps): Promise<number> {
  const logger = createLogger({ role: 'worker' });
  const fetchers = deps.fetchers ?? liveFetchers(env);
  // The mail jobs open sealed values under `code_seal`: read once, at start. The text names the file, never a value.
  const keys = readAppKeys(deps.secretsDir);
  if (typeof keys === 'string') {
    logger.error({ detail: keys }, 'config_invalid');
    return EXIT_CONFIG;
  }
  const mailer = lettermintMailer(env, deps.secretsDir);
  return runWorkerRole(env, {
    handlers: (db) => ({
      ...mailJobs({ db, keys, mailer, logger, env }),
      [MUSEUM_SYNC_JOB]: museumSyncJob(db, fetchers, logger),
      [DATA_EXPORT_JOB]: dataExportJob({ db, exportsDir: EXPORTS_DIR }),
      [STATS_RECOMPUTE_JOB]: statsRecomputeJob(db),
      // MJK_R2_* are read when a tiles job runs, so a worker without them still runs the rest. The secret
      // file r2_media_rw is not optional: Compose does not start the worker without it.
      [TILES_REFRESH_JOB]: tilesRefreshJob({ logger, env }),
      [TILES_ROLLBACK_JOB]: tilesRollbackJob({ logger, env }),
      [MEDIA_PROCESS_JOB]: mediaProcessJob({ db, quarantineDir: QUARANTINE_DIR, decode: createDecode() }),
      [MEDIA_PUBLISH_JOB]: mediaPublishJob({ db, env }),
      [MEDIA_DELETE_JOB]: mediaDeleteJob({ db, env }),
      [COMMONS_SYNC_JOB]: commonsSyncJob({ db, env, logger }),
      [COMMONS_IMAGE_JOB]: commonsImageJob({ db, env, logger }),
    }),
    logger,
    signal: stopSignal(deps),
    heartbeatPath,
  });
}

/** The api daemon (A§5): Hono on :8080 as mjk_api until SIGTERM or SIGINT, then a drain. */
function runApiRole(env: Env, heartbeatPath: string, log: (line: string) => void, deps: RunDeps): Promise<number> {
  return runApi(env, {
    logger: createLogger({ role: 'api' }),
    signal: stopSignal(deps),
    heartbeatPath,
    log,
    ...(deps.port === undefined ? {} : { port: deps.port }),
    ...(deps.hostname === undefined ? {} : { hostname: deps.hostname }),
    ...(deps.onListening === undefined ? {} : { onListening: deps.onListening }),
    ...(deps.secretsDir === undefined ? {} : { secretsDir: deps.secretsDir }),
  });
}

/** The ssr daemon (A§5): Hono on :8081 as mjk_ssr, rendering the public pages, until SIGTERM or SIGINT, then a drain. */
function runSsrRole(env: Env, heartbeatPath: string, log: (line: string) => void, deps: RunDeps): Promise<number> {
  return runSsr(env, {
    logger: createLogger({ role: 'ssr' }),
    signal: stopSignal(deps),
    heartbeatPath,
    log,
    ...(deps.port === undefined ? {} : { port: deps.port }),
    ...(deps.hostname === undefined ? {} : { hostname: deps.hostname }),
    ...(deps.onListening === undefined ? {} : { onListening: deps.onListening }),
  });
}

/** Resolves with the exit code. `heartbeatPath` and `deps` are test seams. */
export async function run(
  argv: readonly string[],
  env: Env,
  log: (line: string) => void = (line) => console.error(line),
  heartbeatPath = HEARTBEAT_PATH,
  deps: RunDeps = {},
): Promise<number> {
  const [role, ...rest] = argv;
  if (role === undefined || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return EXIT_NOT_BUILT;
  }
  switch (role) {
    case 'healthcheck':
    case 'migrate':
      if (rest.length > 0) {
        log(USAGE);
        return EXIT_USAGE;
      }
      return role === 'healthcheck' ? (healthy(heartbeatPath) ? 0 : 1) : runMigrate(env, log);
    case 'worker':
    case 'api':
    case 'ssr':
      if (rest.length > 0) {
        log(USAGE);
        return EXIT_USAGE;
      }
      if (role === 'worker') return runWorker(env, heartbeatPath, deps);
      return role === 'api' ? runApiRole(env, heartbeatPath, log, deps) : runSsrRole(env, heartbeatPath, log, deps);
    case 'media': {
      if (rest.length > 0) {
        log(USAGE);
        return EXIT_USAGE;
      }
      // Loaded only here, so the api, ssr and worker processes never load sharp or libvips.
      const { runMediaRole } = await import('./media/role.ts');
      // The container's /tmp and PID namespace: wiped and swept after every task (media/role.ts).
      return runMediaRole({ signal: stopSignal(deps), heartbeatPath, container: { tmpDir: '/tmp', procDir: '/proc' } });
    }
    case 'backup':
      if (rest.length > 0) {
        log(USAGE);
        return EXIT_USAGE;
      }
      return runBackup(env, { signal: stopSignal(deps), ...deps.backup });
    case 'sync-museums':
      return runSyncRole(rest, env, log, deps);
    case 'admin':
      return runAdmin(rest, env, deps.out ? { ...nodeIo(), out: deps.out, err: log } : nodeIo(), deps.secretsDir);
    default:
      log(`role ${role} is not built yet`);
      return EXIT_NOT_BUILT;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
