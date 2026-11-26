import { JobError } from '../worker/types.ts';

// The Protomaps build list (A§15.3): `builds.json` names the daily planet builds, and a build is kept for one
// week only. Provider text is data: only an entry that passes the filters counts, and nothing of it is read
// beyond its key and version. The source URL is built from a validated key, never taken from the list.

export const BUILDS_URL = 'https://build-metadata.protomaps.dev/builds.json';
export const SOURCE_BASE = 'https://build.protomaps.com/';
/** The schema major of the tiles that `@protomaps/basemaps` 5.x draws (the fixture is 4.15.2). */
export const TILES_MAJOR = 4;
/** The list is about 12 KB. */
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

const KEY = /^(20[0-9]{6})\.pmtiles$/;
const VERSION = new RegExp(`^${TILES_MAJOR}\\.[0-9]{1,4}\\.[0-9]{1,4}$`);

/** `date` is `YYYYMMDD`. */
export type Build = { date: string; url: string };

/** `YYYYMMDD` that names a real calendar date. */
function isCalendarDate(date: string): boolean {
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8))];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * The newest build we may extract: a key `20YYMMDD.pmtiles` with a real date that is not after tomorrow in UTC
 * (a day of slack for clock skew) and a `version` of our schema major. A date listed twice with two versions is
 * ambiguous and dropped. Undefined when nothing qualifies; throws `tiles_builds_invalid` for text that is not a
 * JSON array.
 */
export function newestBuild(text: string, now: Date): Build | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new JobError('tiles_builds_invalid', { retry: false });
  }
  if (!Array.isArray(doc)) throw new JobError('tiles_builds_invalid', { retry: false });
  const latest = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10).replaceAll('-', '');
  const found = new Map<string, string | null>();
  for (const item of doc as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { key, version } = item as Record<string, unknown>;
    if (typeof key !== 'string' || typeof version !== 'string' || !VERSION.test(version)) continue;
    const date = KEY.exec(key)?.[1];
    if (date === undefined || date > latest || !isCalendarDate(date)) continue;
    found.set(date, found.has(date) && found.get(date) !== version ? null : version);
  }
  const date = [...found]
    .filter(([, v]) => v !== null)
    .map(([d]) => d)
    .sort()
    .at(-1);
  return date === undefined ? undefined : { date, url: `${SOURCE_BASE}${date}.pmtiles` };
}

/** The list's text: one GET, no redirect, a timeout and a cap. Never an error message (it can quote the URL). */
export async function fetchBuilds(signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(BUILDS_URL, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, timeout]),
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new JobError('tiles_builds_unavailable');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength;
      if (total > MAX_BYTES) throw new JobError('tiles_builds_invalid', { retry: false });
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (err) {
    if (err instanceof JobError) throw err;
    // A network error, a timeout, an abort or invalid UTF-8.
    throw new JobError(signal.aborted ? 'tiles_aborted' : 'tiles_builds_unavailable');
  }
}
