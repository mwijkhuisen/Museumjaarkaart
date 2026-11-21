import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { dbUrl, EXIT_CONFIG } from '../db/migrate.ts';
import { createLogger, type Logger } from '../lib/log.ts';
import {
  type BackupConfig,
  dumpPath,
  ORIGINALS_DIR,
  PG_DUMP_BIN,
  parseBackupConfig,
  pgDumpArgs,
  pgDumpEnv,
  pgpassLine,
  RESTIC_BIN,
  RESTIC_EXIT,
  resticBackupArgs,
  resticEnv,
  resticInitArgs,
  resticProbeArgs,
  SECRETS_DIR,
  STAGING_DIR,
} from './plan.ts';

// The `backup` role (A§5, A§17.6, ADR-0011): a one-shot job as mjk_backup.
//
//   1. pg_dump -Fc of the database into the staging directory, the excluded tables' data left out;
//   2. restic backup of that dump and /srv/mjk/originals into the R2 bucket `mjk-backup`;
//   3. the dump and the pgpass are deleted, whatever happened.
//
// It never runs `forget` or `prune`: the bucket key could not, and retention is the owner's
// weekly job from the workstation. The health ping is the host unit's (interfaces.md, Q5).
// Logs are fixed codes and numbers: no path of a secret, no child output, no environment.

type Env = Readonly<Record<string, string | undefined>>;

export const EXIT_UNAVAILABLE = 69;
export const EXIT_SOFTWARE = 70;
export { EXIT_CONFIG };

const PG_DUMP_TIMEOUT_MS = 60 * 60_000;
const RESTIC_QUICK_TIMEOUT_MS = 5 * 60_000;
const RESTIC_BACKUP_TIMEOUT_MS = 6 * 3_600_000;
const OUTPUT_MAX = 16 * 1024 * 1024;

export type BackupDeps = {
  logger?: Logger;
  /** Aborts the children (SIGTERM of the container); the role then exits 70 `backup_aborted`. */
  signal?: AbortSignal;
  secretsDir?: string;
  stagingDir?: string;
  /** The directory of the uploaded originals; `null` backs up the dump alone. */
  originalsDir?: string | null;
  /** Where the 0600 pgpass directory is made (the container's tmpfs). */
  tmpDir?: string;
  pgDumpBin?: string;
  resticBin?: string;
};

type Child = { exit: number | 'spawn' | 'killed'; stdout: string };

/** Runs a child with exactly `env`, captures its output (never logged) and reports how it ended. */
function runChild(
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  opts: { timeoutMs: number; signal: AbortSignal | undefined },
): Promise<Child> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        env: { ...env },
        timeout: opts.timeoutMs,
        maxBuffer: OUTPUT_MAX,
        encoding: 'utf8',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      },
      (error, stdout) => {
        if (error === null) return resolve({ exit: 0, stdout });
        const e = error as { code?: unknown; killed?: boolean; signal?: unknown };
        if (typeof e.code === 'number') return resolve({ exit: e.code, stdout });
        resolve({ exit: e.killed === true || e.signal != null ? 'killed' : 'spawn', stdout });
      },
    );
  });
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
};
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The snapshot's short id and counts from restic's `--json` summary line, if there is one. */
export function summaryOf(stdout: string): { snapshot: string; filesNew: number } | undefined {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line) as { message_type?: unknown; snapshot_id?: unknown; files_new?: unknown };
      if (j.message_type === 'summary' && typeof j.snapshot_id === 'string' && /^[0-9a-f]{8,64}$/.test(j.snapshot_id)) {
        return { snapshot: j.snapshot_id.slice(0, 8), filesNew: typeof j.files_new === 'number' ? j.files_new : 0 };
      }
    } catch {
      // Not a summary.
    }
  }
  return undefined;
}

/** Can mjk_backup log in at all? A refused connection is `unavailable` (69), not a failed dump. */
async function databaseAnswers(url: URL): Promise<boolean> {
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5_000,
    application_name: 'mjk_backup',
  });
  // An error event must not crash the process; its message can quote the connection.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Resolves with the exit code: 0, 69 unavailable, 70 failed, 78 config. */
export async function runBackup(env: Env, deps: BackupDeps = {}): Promise<number> {
  const logger = deps.logger ?? createLogger({ role: 'backup' });
  const secretsDir = deps.secretsDir ?? SECRETS_DIR;
  const stagingDir = deps.stagingDir ?? STAGING_DIR;
  const originalsDir = deps.originalsDir === undefined ? ORIGINALS_DIR : deps.originalsDir;
  const signal = deps.signal;

  const configured = parseBackupConfig(env);
  if (!configured.ok) {
    logger.error({ code: configured.code }, 'config_invalid');
    return EXIT_CONFIG;
  }
  const cfg: BackupConfig = configured.config;
  const url = dbUrl('mjk_backup', env, secretsDir);
  if (typeof url === 'string') {
    // The text names the secret file, never its content; only a fixed code is logged.
    logger.error({ code: 'database_config' }, 'config_invalid');
    return EXIT_CONFIG;
  }
  for (const secret of ['restic_password', 'r2_backup_put']) {
    if (!isFile(join(secretsDir, secret))) {
      logger.error({ code: `secret_${secret}` }, 'config_invalid');
      return EXIT_CONFIG;
    }
  }
  if (!isDir(stagingDir)) {
    logger.error({ code: 'staging_missing' }, 'config_invalid');
    return EXIT_CONFIG;
  }
  if (originalsDir !== null && !isDir(originalsDir)) {
    logger.error({ code: 'originals_missing' }, 'config_invalid');
    return EXIT_CONFIG;
  }

  logger.info({}, 'backup_started');
  if (!(await databaseAnswers(url))) {
    logger.error({}, 'db_unavailable');
    return EXIT_UNAVAILABLE;
  }

  const dump = dumpPath(stagingDir);
  const pgDir = mkdtempSync(join(deps.tmpDir ?? '/tmp', 'mjk-backup-'));
  const pgpass = join(pgDir, 'pgpass');
  const restic = deps.resticBin ?? RESTIC_BIN;
  const resticEnvironment = resticEnv(cfg, secretsDir);
  const aborted = () => signal?.aborted === true;
  const failed = (step: string, extra: Record<string, number | string> = {}): number => {
    if (aborted()) {
      logger.error({ step }, 'backup_aborted');
    } else {
      logger.error({ step, ...extra }, 'backup_failed');
    }
    return EXIT_SOFTWARE;
  };

  try {
    // 1. The dump. A left-over of a killed run is removed first; the password is written
    // with mode 0600 into a fresh 0700 directory and reaches pg_dump as a path only.
    rmSync(dump, { force: true });
    writeFileSync(pgpass, pgpassLine(url), { mode: 0o600, flag: 'wx' });
    const dumped = await runChild(deps.pgDumpBin ?? PG_DUMP_BIN, pgDumpArgs(dump), pgDumpEnv(url, pgpass), {
      timeoutMs: PG_DUMP_TIMEOUT_MS,
      signal,
    });
    if (dumped.exit !== 0) return failed('pg_dump', { exit: dumped.exit });
    let bytes = 0;
    try {
      bytes = statSync(dump).size;
    } catch {
      // Reported below.
    }
    if (bytes === 0) return failed('dump_empty');
    logger.info({ bytes }, 'dump_done');
    rmSync(pgDir, { recursive: true, force: true }); // the password is not needed any more

    // 2. The repository: it exists, or this is the very first run (restic exit 10) and it is created.
    const probe = await runChild(restic, resticProbeArgs(), resticEnvironment, {
      timeoutMs: RESTIC_QUICK_TIMEOUT_MS,
      signal,
    });
    if (probe.exit === RESTIC_EXIT.wrongPassword) {
      logger.error({ code: 'restic_password_rejected' }, 'config_invalid');
      return EXIT_CONFIG;
    }
    if (probe.exit === RESTIC_EXIT.noRepository) {
      const init = await runChild(restic, resticInitArgs(), resticEnvironment, {
        timeoutMs: RESTIC_QUICK_TIMEOUT_MS,
        signal,
      });
      if (init.exit !== 0) return failed('restic_init', { exit: init.exit });
      logger.info({}, 'repo_created');
    } else if (probe.exit !== 0) {
      if (aborted()) return failed('restic_probe');
      logger.error({ exit: probe.exit }, 'repo_unavailable');
      return EXIT_UNAVAILABLE;
    }

    // 3. The snapshot: the dump and the originals.
    const paths = originalsDir === null ? [dump] : [dump, originalsDir];
    const snap = await runChild(restic, resticBackupArgs(paths), resticEnvironment, {
      timeoutMs: RESTIC_BACKUP_TIMEOUT_MS,
      signal,
    });
    const summary = summaryOf(snap.stdout);
    if (snap.exit === RESTIC_EXIT.incomplete) {
      // The snapshot exists but some file could not be read: the owner must look at it.
      logger.error({ snapshot: summary?.snapshot ?? null }, 'restic_incomplete');
      return EXIT_SOFTWARE;
    }
    if (snap.exit !== 0) return failed('restic_backup', { exit: snap.exit });
    logger.info({ snapshot: summary?.snapshot ?? null, filesNew: summary?.filesNew ?? null }, 'backup_done');
    return 0;
  } catch {
    // No message: it can quote a path or a connection.
    return failed('internal');
  } finally {
    rmSync(dump, { force: true });
    rmSync(pgDir, { recursive: true, force: true });
  }
}
