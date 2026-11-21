import { join } from 'node:path';

// The pure part of the `backup` role (A§17.6, ADR-0011): what runs, with which arguments and
// which environment. Nothing here touches the file system or starts a process. Every child
// process gets an environment built here from named values, never `process.env` wholesale, and
// no secret value ever lands in an argument list: the database password goes through a pgpass
// file, the restic password and the R2 key through file paths.

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Tables whose data is not backed up (A§17.6): a restore signs everyone out and starts with an
 * empty queue. Their structure is still in the dump. A table that does not exist yet (the
 * P2 tables) matches nothing, and pg_dump (without --strict-names) does not complain about it.
 */
export const EXCLUDED_TABLE_DATA = ['session', 'email_code', 'auth_challenge', 'rate_limit', 'job'] as const;

export const STAGING_DIR = '/srv/mjk/backup-staging';
export const ORIGINALS_DIR = '/srv/mjk/originals';
export const SECRETS_DIR = '/run/secrets';
export const DUMP_NAME = 'mjk.dump';
/** Fixed, so the snapshots of every night are one series (a container's hostname changes per run). */
export const RESTIC_HOST = 'mjk';
export const RESTIC_TAG = 'nightly';
export const PG_DUMP_BIN = '/usr/local/bin/pg_dump';
export const RESTIC_BIN = '/usr/local/bin/restic';
/** Fixed PATH of the children: neither tool needs more. */
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';
const TMP = '/tmp';

export type BackupConfig = {
  /** `s3:<endpoint>/<bucket>`, restic's repository string. */
  repository: string;
  region: string;
};

export type ConfigResult = { ok: true; config: BackupConfig } | { ok: false; code: string };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The endpoint (`MJK_R2_ENDPOINT`) and the bucket (`MJK_R2_BUCKET_BACKUP`) from the config, or a
 * fixed code. https only; plain http is accepted for loopback, which is the MinIO stand-in. The
 * region is `auto` (R2), or `MJK_R2_REGION` for a stand-in that insists on a real one.
 */
export function parseBackupConfig(env: Env): ConfigResult {
  const endpoint = env.MJK_R2_ENDPOINT;
  const bucket = env.MJK_R2_BUCKET_BACKUP;
  if (endpoint === undefined || endpoint === '' || bucket === undefined || bucket === '') {
    return { ok: false, code: 'config_missing' };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, code: 'endpoint_invalid' };
  }
  const tls = url.protocol === 'https:';
  if (!tls && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return { ok: false, code: 'endpoint_invalid' };
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    return { ok: false, code: 'endpoint_invalid' };
  }
  if (!BUCKET.test(bucket) || bucket.includes('..')) return { ok: false, code: 'bucket_invalid' };
  const region = env.MJK_R2_REGION ?? 'auto';
  if (!REGION.test(region)) return { ok: false, code: 'region_invalid' };
  return { ok: true, config: { repository: `s3:${url.origin}/${bucket}`, region } };
}

/** Where the dump goes while restic reads it. */
export const dumpPath = (stagingDir: string): string => join(stagingDir, DUMP_NAME);

/** pg_dump's arguments: custom format to `file`, the excluded tables' data left out. No password. */
export function pgDumpArgs(file: string): string[] {
  return [
    '--format=custom',
    '--no-password',
    '--lock-wait-timeout=60s',
    `--file=${file}`,
    // `public.` pins the schema; a pattern that matches no table is not an error.
    ...EXCLUDED_TABLE_DATA.map((t) => `--exclude-table-data=public.${t}`),
  ];
}

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const dbName = (url: URL) => decoded(url.pathname.replace(/^\//, ''));

/** One pgpass line: `host:port:database:user:password`, with `\` and `:` escaped (libpq's rule). */
export function pgpassLine(url: URL): string {
  const esc = (s: string) => s.replace(/[\\:]/g, (c) => `\\${c}`);
  const fields = [
    url.hostname.replace(/^\[|\]$/g, ''),
    url.port === '' ? '5432' : url.port,
    dbName(url),
    decoded(url.username),
    decoded(url.password),
  ];
  return `${fields.map(esc).join(':')}\n`;
}

const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

/** pg_dump's environment: the connection by name (never a conninfo string or the password) and the pgpass path. */
export function pgDumpEnv(url: URL, pgpass: string): Record<string, string> {
  const sslmode = url.searchParams.get('sslmode');
  return {
    PATH: CHILD_PATH,
    HOME: TMP,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port === '' ? '5432' : url.port,
    PGUSER: decoded(url.username),
    PGDATABASE: dbName(url),
    PGPASSFILE: pgpass,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'mjk_backup',
    ...(sslmode !== null && SSL_MODES.has(sslmode) ? { PGSSLMODE: sslmode } : {}),
  };
}

/** restic's environment: the repository and the two secret files by path, a bounded cache dir, nothing else. */
export function resticEnv(cfg: BackupConfig, secretsDir: string = SECRETS_DIR): Record<string, string> {
  return {
    PATH: CHILD_PATH,
    HOME: TMP,
    TMPDIR: TMP,
    XDG_CACHE_HOME: `${TMP}/.cache`,
    RESTIC_REPOSITORY: cfg.repository,
    RESTIC_PASSWORD_FILE: `${secretsDir}/restic_password`,
    AWS_SHARED_CREDENTIALS_FILE: `${secretsDir}/r2_backup_put`,
    AWS_DEFAULT_REGION: cfg.region,
  };
}

/** `restic cat config`: exit 0 when the repository exists, 10 when it does not, 12 for a wrong password. */
export const resticProbeArgs = (): string[] => ['--no-cache', '--quiet', 'cat', 'config'];

/** `restic init` for the very first run. */
export const resticInitArgs = (): string[] => ['--no-cache', '--quiet', 'init'];

/**
 * `restic backup` of the dump and the originals, as one snapshot series on a fixed host name.
 * `--no-cache` keeps restic inside the container's 256 MiB and its read-only file system.
 * Never `forget` or `prune`: the key cannot, and retention runs from the workstation (A§17.6).
 */
export function resticBackupArgs(paths: readonly string[]): string[] {
  return ['--no-cache', '--quiet', '--json', 'backup', '--host', RESTIC_HOST, '--tag', RESTIC_TAG, '--', ...paths];
}

/** restic exit codes (0.17 and later) that the role tells apart. */
export const RESTIC_EXIT = { incomplete: 3, noRepository: 10, locked: 11, wrongPassword: 12 } as const;
