import { readSecret, SECRETS_DIR } from '../db/migrate.ts';
import type { Logger } from './log.ts';

// healthchecks.io pings (A§17.7, A8): `https://hc-ping.com/<ping key>/<slug>`, with `/fail` for a
// failure. The key is the file secret `hc_ping_key` (GID 63013, the worker only). The URL and
// the key are never logged, never put in an error and never returned: a ping answers true or
// false, and a failure is the fixed code `healthchecks_ping_failed` (invariant 1 and 8).
// Without a readable key the pinger is disabled and says so once.

export const HC_PING_ORIGIN = 'https://hc-ping.com';
export const HC_KEY_SECRET = 'hc_ping_key';
export const HC_TIMEOUT_MS = 10_000;

/** healthchecks.io ping keys are short URL-safe tokens; anything else is a misconfigured file. */
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** A check slug: lower case letters, digits, hyphen, underscore. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type PingKind = 'success' | 'fail';

export type Pinger = {
  /** False when there is no (valid) key: every ping is then a no-op that answers false. */
  readonly enabled: boolean;
  /** One ping of the check `slug`; true when healthchecks answered 2xx. Never throws, never logs the URL. */
  ping(slug: string, kind?: PingKind): Promise<boolean>;
};

export type PingerOptions = {
  logger: Logger;
  /** Test seam: where the key file lives (default /run/secrets). */
  secretsDir?: string;
  /** Test seam: the fetch to use (default the global one, which msw intercepts in tests). */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** The URL of one ping, or undefined for a key or slug that is not well formed. */
export function pingUrl(key: string, slug: string, kind: PingKind): string | undefined {
  if (!KEY.test(key) || !SLUG.test(slug)) return undefined;
  return `${HC_PING_ORIGIN}/${key}/${slug}${kind === 'fail' ? '/fail' : ''}`;
}

const disabled = (): Pinger => ({ enabled: false, ping: async () => false });

export function createPinger(opts: PingerOptions): Pinger {
  const { logger } = opts;
  const key = readSecret(HC_KEY_SECRET, opts.secretsDir ?? SECRETS_DIR);
  if (key === undefined) {
    logger.warn({}, 'healthchecks_disabled');
    return disabled();
  }
  if (!KEY.test(key)) {
    logger.warn({}, 'healthchecks_key_invalid');
    return disabled();
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? HC_TIMEOUT_MS;
  return {
    enabled: true,
    async ping(slug, kind = 'success') {
      const url = pingUrl(key, slug, kind);
      if (url === undefined) {
        logger.warn({ kind }, 'healthchecks_slug_invalid');
        return false;
      }
      try {
        const res = await doFetch(url, {
          method: 'POST',
          // Never follow: a redirect would carry the key to another host.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel().catch(() => {});
        if (res.ok) return true;
        logger.warn({ kind, status: res.status }, 'healthchecks_ping_failed');
        return false;
      } catch {
        // No message: it can quote the URL.
        logger.warn({ kind }, 'healthchecks_ping_failed');
        return false;
      }
    },
  };
}
