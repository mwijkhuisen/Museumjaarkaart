import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { sql } from 'kysely';
import { createDb, type Db } from '../db/kysely.ts';
import { EXIT_CONFIG } from '../db/migrate.ts';
import { API_POOL_MAX, API_STATEMENT_TIMEOUT_MS, createPool } from '../db/pool.ts';
import { HEARTBEAT_EVERY_MS, touch } from '../heartbeat.ts';
import type { Logger } from '../lib/log.ts';
import { createApp } from './app.ts';

// The `api` role (A§5): Hono on :8080 as mjk_api. The heartbeat is touched while the database
// answers, so `healthcheck` turns unhealthy when it does not; SIGTERM drains, then exits 0.

type Env = Readonly<Record<string, string | undefined>>;

export const API_PORT = 8080;
/** How long a drain waits for open requests before it closes their connections. */
export const DRAIN_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;

/** `select 1` within PING_TIMEOUT_MS. */
export function pinger(db: Db): () => Promise<boolean> {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    });
    try {
      return await Promise.race([sql`select 1`.execute(db).then(() => true as const), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Listens on `hostname:port`; resolves with the server once it listens, or rejects (e.g. EADDRINUSE). */
export async function listen(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  port: number,
  hostname: string,
): Promise<Server> {
  // overrideGlobalObjects: false keeps Node's own Request and Response globals.
  const server = serve({ fetch: app.fetch, port, hostname, overrideGlobalObjects: false }) as Server;
  await Promise.race([once(server, 'listening'), once(server, 'error').then(([err]) => Promise.reject(err))]);
  return server;
}

/** Stops accepting, lets open requests finish for up to `ms`, then closes what is left. */
export async function drain(server: Server, ms = DRAIN_MS): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const force = setTimeout(() => server.closeAllConnections(), ms);
  force.unref();
  await closed;
  clearTimeout(force);
}

export type ApiRunOpts = {
  logger: Logger;
  signal: AbortSignal;
  heartbeatPath: string;
  /** A config error line (names the variable or file, never a secret). */
  log: (line: string) => void;
  port?: number;
  hostname?: string;
  /** Test seam: the port it listens on (0 picks a free one). */
  onListening?: (port: number) => void;
};

export async function runApi(env: Env, opts: ApiRunOpts): Promise<number> {
  const { logger } = opts;
  const pool = createPool('mjk_api', env, { max: API_POOL_MAX, statementTimeoutMs: API_STATEMENT_TIMEOUT_MS });
  if (typeof pool === 'string') {
    opts.log(`api: ${pool}`);
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  const ping = pinger(db);
  let server: Server;
  try {
    server = await listen(createApp({ db, logger, ping }), opts.port ?? API_PORT, opts.hostname ?? '0.0.0.0');
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
  logger.info({ port }, 'api_listening');
  opts.onListening?.(port);

  if (!opts.signal.aborted) await once(opts.signal, 'abort');
  clearInterval(timer);
  logger.info({}, 'api_draining');
  await drain(server);
  await db.destroy();
  logger.info({}, 'api_stopped');
  return 0;
}
