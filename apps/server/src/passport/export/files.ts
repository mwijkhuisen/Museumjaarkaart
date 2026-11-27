import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExportFile } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../../db/kysely.ts';

// The export bundles on disk (A§10, A§17.1: `/srv/mjk/exports`, worker rw, api ro): `<dir>/<export id>/<file>`.
// Every path is built from a validated uuid and one of ExportFile's names, never from request text. No
// path column in the database: the directory is found from the row's id.

export const EXPORT_FILES = ExportFile.options;

/** Where the bundles live in both containers (A§17.1, deploy/compose.yaml: the worker rw, the api ro). */
export const EXPORTS_DIR = '/srv/mjk/exports';

/** A directory name that is an export's id (the lower-case form PostgreSQL prints). */
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMP_PREFIX = '.tmp-';
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Writes the bundle into a fresh temporary directory (0700, files 0600), then replaces any old
 * `<dir>/<id>` with it, so a retry starts clean and a reader never sees half a bundle.
 */
export async function writeBundle(dir: string, id: string, files: Readonly<Record<ExportFile, string>>): Promise<void> {
  const tmp = join(dir, `${TMP_PREFIX}${id}-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(tmp, { mode: 0o700 });
    for (const name of EXPORT_FILES) await writeFile(join(tmp, name), files[name], { mode: 0o600, flag: 'wx' });
    await rm(join(dir, id), { recursive: true, force: true });
    await rename(tmp, join(dir, id));
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** One file of a bundle, or undefined when it is not there (purged). `id` must be a validated uuid. */
export async function readBundleFile(dir: string, id: string, file: ExportFile): Promise<Buffer | undefined> {
  try {
    return await readFile(join(dir, id, file));
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Removes every bundle whose row is gone, failed, or ready and expired, and every temporary directory over
 * an hour old; anything else in the directory is left alone. A `queued` row's bundle stays: its job may have
 * renamed it into place and not yet committed `ready`. Counts only.
 */
export async function purgeExportFiles(db: Db, dir: string): Promise<{ bundles: number; tmp: number }> {
  // No directory (a worker without the mount, tests): nothing to purge.
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  });
  const ids = names.filter((n) => UUID_DIR.test(n));
  const keep = new Set(
    ids.length === 0
      ? []
      : (
          await db
            .selectFrom('data_export')
            .select('id')
            .where('id', 'in', ids)
            .where((w) =>
              w.or([
                w('state', '=', 'queued'),
                w.and([w('state', '=', 'ready'), w('expires_at', '>', sql<Date>`now()`)]),
              ]),
            )
            .execute()
        ).map((r) => r.id),
  );
  let bundles = 0;
  for (const id of ids) {
    if (keep.has(id)) continue;
    await rm(join(dir, id), { recursive: true, force: true });
    bundles++;
  }
  let tmp = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const st = await lstat(join(dir, name)).catch(() => undefined);
    if (st === undefined || Date.now() - st.mtimeMs < TMP_MAX_AGE_MS) continue;
    await rm(join(dir, name), { recursive: true, force: true });
    tmp++;
  }
  return { bundles, tmp };
}
