import { stat } from 'node:fs/promises';
import type { Logger } from '../lib/log.ts';
import type { R2Client } from '../media/r2.ts';
import { JobError } from '../worker/types.ts';

// Publishing the tiles to the media bucket (A§12, A§15.3, ADR-0014): `tiles/nl-<build>.pmtiles` is immutable,
// and `tiles/current.json` (a short cache) names the file the map reads and the one before it, which stays
// for a rollback until the next refresh has succeeded. The new file is uploaded and checked first, the pointer
// flips second, and only then is the file two refreshes back deleted. The e2e stack's seed
// (`apps/server/scripts/seed-e2e-tiles.ts`) writes its fixture file and `current.json` with the R2 client directly,
// so the flip is covered by `publish.int.test.ts`, not by the e2e stack.

export const CURRENT_KEY = 'tiles/current.json';
/** `nl-<YYYYMMDD>.pmtiles`: the only names that ever reach a key. */
export const TILES_FILE = /^nl-20[0-9]{6}\.pmtiles$/;
const TILES_TYPE = 'application/vnd.pmtiles';
export const IMMUTABLE = 'public, max-age=31536000, immutable';
const CURRENT_CACHE = 'public, max-age=300';
const CURRENT_MAX_BYTES = 1024;

export type Current = { file: string; previous: string | null };

export const tilesKey = (file: string) => `tiles/${file}`;

/** R2Client.head and .delete take an optional signal, not an undefined one (exactOptionalPropertyTypes). */
const only = (signal: AbortSignal | undefined): { signal?: AbortSignal } => (signal === undefined ? {} : { signal });

/** Strict: exactly `file` and `previous`, both names of ours, and not the same. */
export function parseCurrent(bytes: Uint8Array): Current {
  const bad = () => new JobError('tiles_current_invalid', { retry: false });
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw bad();
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw bad();
  const keys = Object.keys(doc).sort();
  const { file, previous } = doc as Record<string, unknown>;
  if (keys.length !== 2 || keys[0] !== 'file' || keys[1] !== 'previous') throw bad();
  if (typeof file !== 'string' || !TILES_FILE.test(file)) throw bad();
  if (previous !== null && (typeof previous !== 'string' || !TILES_FILE.test(previous) || previous === file))
    throw bad();
  return { file, previous };
}

/** The pointer, or null on the first run. */
export async function readCurrent(client: R2Client, signal?: AbortSignal): Promise<Current | null> {
  const bytes = await client.get(CURRENT_KEY, { maxBytes: CURRENT_MAX_BYTES, signal });
  return bytes === null ? null : parseCurrent(bytes);
}

const writeCurrent = (client: R2Client, current: Current, signal?: AbortSignal) =>
  client.put(CURRENT_KEY, `${JSON.stringify(current)}\n`, {
    contentType: 'application/json',
    cacheControl: CURRENT_CACHE,
    signal,
  });

/**
 * Uploads `path` as `tiles/<file>`, checks the stored size, flips `current.json` to it (the old file becomes
 * `previous`) and deletes the old `previous` (the file two back) unless it is one of the two names now. A file
 * that is already current or previous is not uploaded again (its key is immutable): the pointer is returned
 * as it is. The delete is best effort: an orphan costs storage, a failed job would not flip back.
 */
export async function publishTiles(
  client: R2Client,
  path: string,
  file: string,
  opts: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<Current> {
  const { signal } = opts;
  if (!TILES_FILE.test(file)) throw new JobError('tiles_bad_file', { retry: false });
  const old = await readCurrent(client, signal);
  if (old !== null && (old.file === file || old.previous === file)) return old;
  const key = tilesKey(file);
  const { size } = await stat(path);
  await client.putFile(key, path, { contentType: TILES_TYPE, cacheControl: IMMUTABLE, signal });
  const stored = await client.head(key, only(signal));
  if (stored === null || stored.size !== size) throw new JobError('tiles_size_mismatch');
  const next: Current = { file, previous: old?.file ?? null };
  await writeCurrent(client, next, signal);
  const stale = old?.previous ?? null;
  if (stale !== null && stale !== next.file && stale !== next.previous) {
    try {
      await client.delete(tilesKey(stale), only(signal));
    } catch {
      opts.logger?.warn({}, 'tiles_old_delete_failed');
    }
  }
  return next;
}

/** Swaps `current.json` back to the previous file, which has to exist still. */
export async function rollbackTiles(client: R2Client, opts: { signal?: AbortSignal } = {}): Promise<Current> {
  const { signal } = opts;
  const old = await readCurrent(client, signal);
  if (old === null || old.previous === null) throw new JobError('tiles_no_previous', { retry: false });
  if ((await client.head(tilesKey(old.previous), only(signal))) === null) {
    throw new JobError('tiles_no_previous', { retry: false });
  }
  const next: Current = { file: old.previous, previous: old.file };
  await writeCurrent(client, next, signal);
  return next;
}
