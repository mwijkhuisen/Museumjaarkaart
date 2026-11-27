import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DISK_FILE_MAX_AGE_MS, DISK_MIN_FREE_PCT } from './limits.ts';

// The disk guard (A§17.7, owner Q6). mjk-tick writes `/srv/mjk/state/guard/disk` every 10 minutes
// (`free_pct=…`, `free_bytes=…`, `total_bytes=…`, `checked=<UTC ISO>`) by writing a temp file and renaming it,
// which is why the api mounts the `guard` directory and never the file itself (a file bind mount would keep
// the old inode). Fail closed: an unreadable, malformed or stale file counts as under the guard.

const MAX_BYTES = 1024;
/** A `checked` this far in the future still counts (the host's and the container's clocks are the same). */
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const CHECKED = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** Whether a new upload may start: the guard file is fresh and shows at least DISK_MIN_FREE_PCT free. */
export async function diskAllowsUploads(guardDir: string, nowMs: number = Date.now()): Promise<boolean> {
  let text: string;
  try {
    const fh = await open(join(guardDir, 'disk'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_BYTES) return false;
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const pct = fields.get('free_pct') ?? '';
  const checked = fields.get('checked') ?? '';
  if (!/^[0-9]{1,3}$/.test(pct) || !CHECKED.test(checked)) return false;
  const at = Date.parse(checked);
  if (Number.isNaN(at) || nowMs - at > DISK_FILE_MAX_AGE_MS || at - nowMs > FUTURE_SLACK_MS) return false;
  return Number(pct) >= DISK_MIN_FREE_PCT;
}
