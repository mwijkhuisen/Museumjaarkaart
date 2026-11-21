import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchApi } from '@mjk/contracts';
import { buildApp, mountCatalogue } from '../api/app.ts';
import { drain, listen, pinger } from '../api/server.ts';
import { createDb, type Db } from '../db/kysely.ts';
import { EXIT_CONFIG } from '../db/migrate.ts';
import { createPool } from '../db/pool.ts';
import { HEARTBEAT_EVERY_MS, touch } from '../heartbeat.ts';
import type { Logger } from '../lib/log.ts';
import { createSsrApp } from './app.ts';
import { loadBundle } from './bundle.ts';
import { readSsrConfig } from './config.ts';

// The `ssr` role (A§5): Hono on :8081 as mjk_ssr. It runs the api's own catalogue routes in-process
// (loaders = the API's answers, A§15.1), so a page and the API cannot disagree. The heartbeat is
// touched while the database answers; SIGTERM drains, then exits 0.

type Env = Readonly<Record<string, string | undefined>>;

export const SSR_PORT = 8081;
const SSR_POOL_MAX = 5;
const SSR_STATEMENT_TIMEOUT_MS = 5_000;

export type SsrRunOpts = {
  logger: Logger;
  signal: AbortSignal;
  heartbeatPath: string;
  /** A config error line (names the variable or file, never a secret). */
  log: (line: string) => void;
  port?: number;
  hostname?: string;
  /** Test seam: the port it listens on (0 picks a free one). */
  onListening?: (port: number) => void;
  /** Test seam: where the SSR bundle is. */
  bundleUrl?: URL;
};

/** The api's catalogue routes as a function of a path: the same parse, contract and reshaping as `api`. */
export function inProcessApi(db: Db, logger: Logger): FetchApi {
  // The api's own request lines would double every page's line: only warnings and errors pass.
  // Not a spread: pino's methods need their `this`.
  const quiet: Logger = {
    info: () => {},
    warn: (fields, msg) => logger.warn(fields, msg),
    error: (fields, msg) => logger.error(fields, msg),
  };
  const app = buildApp({ db, logger: quiet, ping: pinger(db) }, mountCatalogue);
  return async (path) => {
    const res = await app.request(path);
    return {
      status: res.status,
      location: res.headers.get('location'),
      body: res.status === 200 ? await res.json() : null,
    };
  };
}

export async function runSsr(env: Env, opts: SsrRunOpts): Promise<number> {
  const { logger } = opts;
  const config = readSsrConfig(env);
  if (typeof config === 'string') {
    opts.log(`ssr: ${config}`);
    return EXIT_CONFIG;
  }
  const pool = createPool('mjk_ssr', env, { max: SSR_POOL_MAX, statementTimeoutMs: SSR_STATEMENT_TIMEOUT_MS });
  if (typeof pool === 'string') {
    opts.log(`ssr: ${pool}`);
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  const bundle = await loadBundle(opts.bundleUrl);
  if (typeof bundle === 'string') {
    // A fixed line per code: never the path or the import's error.
    opts.log(bundle === 'missing' ? 'ssr: the web build is missing' : 'ssr: the web build is broken');
    await db.destroy();
    return EXIT_CONFIG;
  }
  const ping = pinger(db);
  let server: Server;
  try {
    const app = createSsrApp({ bundle, fetchApi: inProcessApi(db, logger), db, config, logger });
    server = await listen(app, opts.port ?? SSR_PORT, opts.hostname ?? '0.0.0.0');
  } catch {
    logger.error({}, 'listen_failed');
    await db.destroy();
    return 1;
  }
  const beat = async () => {
    if (await ping()) touch(opts.heartbeatPath);
  };
  await beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();
  const port = (server.address() as AddressInfo).port;
  logger.info({ port }, 'ssr_listening');
  opts.onListening?.(port);

  if (!opts.signal.aborted) await once(opts.signal, 'abort');
  clearInterval(timer);
  logger.info({}, 'ssr_draining');
  await drain(server);
  await db.destroy();
  logger.info({}, 'ssr_stopped');
  return 0;
}
