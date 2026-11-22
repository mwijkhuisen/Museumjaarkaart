import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NL_BOX } from '@mjk/contracts';
import type { Logger } from '../lib/log.ts';
import { MEDIA_SECRET_PATH, R2Client, readR2Config } from '../media/r2.ts';
import { JobError, type JobHandler } from '../worker/types.ts';
import { fetchBuilds, newestBuild } from './builds.ts';
import { TILE_LIMITS, type TileLimits, tilesProblem } from './header.ts';
import { publishTiles, readCurrent, rollbackTiles } from './publish.ts';

// The quarterly `tiles_refresh` job and its `tiles_rollback` (A§15.3, A§17.1, ADR-0014). One job at a time,
// as mjk_worker. Fixed codes and counts only in the log (invariant 8): never a key, a URL or the credentials.
//
// tiles_refresh: the newest Protomaps build → `pmtiles extract` of the national box into the build directory →
// checks of the file → publishTiles. The build directory is emptied before and, in a `finally`, after.

export const TILES_REFRESH_JOB = 'tiles_refresh';
export const TILES_ROLLBACK_JOB = 'tiles_rollback';
export const BUILD_DIR = '/srv/mjk/tiles-build';
export const PMTILES_BIN = '/usr/local/bin/pmtiles';
/** An extract reads ~1–2 GB in ranges over the network [U]; a stalled source must not hold the one worker for long. */
const EXTRACT_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_GOMEMLIMIT = '300MiB';

type Env = Readonly<Record<string, string | undefined>>;

export type TilesDeps = {
  logger: Logger;
  env: Env;
  /** Test seams. */
  buildDir?: string;
  pmtiles?: string;
  limits?: TileLimits;
  secretPath?: string;
  extractTimeoutMs?: number;
  now?: () => Date;
};

/**
 * Run time, not worker start: a worker without the MJK_R2_* values still runs its other jobs. The secret file
 * is another matter: Compose does not start the worker without it.
 */
const clientOf = (d: TilesDeps) => new R2Client(readR2Config(d.env, d.secretPath ?? MEDIA_SECRET_PATH));

async function emptyDir(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new JobError('tiles_build_dir', { retry: false });
  }
  for (const name of names) await rm(join(dir, name), { recursive: true, force: true });
}

/** `west,south,east,north`: go-pmtiles' order. */
export const bboxArg = (b = NL_BOX) => `--bbox=${b.lonMin},${b.latMin},${b.lonMax},${b.latMax}`;

/**
 * Runs the binary with an argument array (no shell) and a fixed environment, and resolves when the process
 * is gone, so nothing writes into the build directory after it. Its output is never kept.
 */
function extract(bin: string, args: readonly string[], dir: string, d: TilesDeps, signal: AbortSignal) {
  const limit = d.env.GOMEMLIMIT ?? '';
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: dir,
    // /tmp is a small tmpfs; go-pmtiles writes a temporary file as large as the extract.
    TMPDIR: dir,
    GOMEMLIMIT: /^[0-9]{1,6}(?:B|KiB|MiB|GiB)?$/.test(limit) ? limit : DEFAULT_GOMEMLIMIT,
  };
  return new Promise<{ ok: boolean; status: number | null; signal: string | null }>((resolve) => {
    const kill = () => child.kill('SIGKILL');
    const child = execFile(
      bin,
      [...args],
      { env, cwd: dir, timeout: d.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (err) => {
        signal.removeEventListener('abort', kill);
        // A kill (the timeout, an abort, the OOM killer) is `code: null` with the signal's name.
        const { code, signal: sig } = (err ?? {}) as { code?: unknown; signal?: unknown };
        resolve({
          ok: err === null,
          status: typeof code === 'number' ? code : null,
          signal: typeof sig === 'string' ? sig : null,
        });
      },
    );
    if (signal.aborted) kill();
    else signal.addEventListener('abort', kill, { once: true });
  });
}

/** The handler of `tiles_refresh` jobs; the job carries no payload. */
export function tilesRefreshJob(d: TilesDeps): JobHandler {
  return async (_payload, { signal }) => {
    const { logger } = d;
    const client = clientOf(d);
    const buildDir = d.buildDir ?? BUILD_DIR;

    const build = newestBuild(await fetchBuilds(signal), (d.now ?? (() => new Date()))());
    if (build === undefined) throw new JobError('tiles_no_build', { retry: false });
    const file = `nl-${build.date}.pmtiles`;
    logger.info({ build: build.date }, 'tiles_build_found');

    const current = await readCurrent(client, signal);
    // Never older than what is live (fixed-width names, so a string order is the date order): a stale or
    // hostile builds.json must not roll the map back.
    // Also the build that a rollback moved away from: a re-extract would differ byte for byte from an immutable file.
    if (current !== null && (file <= current.file || current.previous === file)) {
      logger.info({ build: build.date }, 'tiles_up_to_date');
      return;
    }

    try {
      await emptyDir(buildDir);
      const out = join(buildDir, file);
      const run = await extract(
        d.pmtiles ?? PMTILES_BIN,
        ['extract', '--quiet', build.url, out, bboxArg()],
        buildDir,
        d,
        signal,
      );
      if (!run.ok) {
        if (signal.aborted) throw new JobError('tiles_aborted');
        logger.error({ status: run.status, signal: run.signal }, 'tiles_extract_failed');
        throw new JobError('tiles_extract_failed');
      }
      const why = await tilesProblem(out, d.limits ?? TILE_LIMITS);
      if (why !== null) {
        logger.error({ why }, 'tiles_bad_file');
        throw new JobError('tiles_bad_file', { retry: false });
      }
      const next = await publishTiles(client, out, file, { signal, logger });
      logger.info({ build: build.date, hasPrevious: next.previous !== null }, 'tiles_published');
    } finally {
      // Success, failure and abort alike; a build directory that cannot be emptied is reported, never thrown over the result.
      await emptyDir(buildDir).catch(() => logger.warn({}, 'tiles_build_dir_not_empty'));
    }
  };
}

/** The handler of `tiles_rollback` jobs: `current.json` points back at the previous file. */
export function tilesRollbackJob(d: TilesDeps): JobHandler {
  return async (_payload, { signal }) => {
    const next = await rollbackTiles(clientOf(d), { signal });
    d.logger.info({ hasPrevious: next.previous !== null }, 'tiles_rolled_back');
  };
}
