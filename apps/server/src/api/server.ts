import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { sql } from 'kysely';
import { readAppKeys } from '../auth/keys.ts';
import { createDb, type Db } from '../db/kysely.ts';
import { EXIT_CONFIG } from '../db/migrate.ts';
import { API_POOL_MAX, API_STATEMENT_TIMEOUT_MS, createPool } from '../db/pool.ts';
import { HEARTBEAT_EVERY_MS, touch } from '../heartbeat.ts';
import type { Logger } from '../lib/log.ts';
import { EXPORTS_DIR } from '../passport/export/files.ts';
import type { ApiDeps } from './app.ts';
import { type ApiConfig, readApiConfig } from './config.ts';
import { certsUrlOf, createJwksCache, issuerOf } from './middleware/access-jwt.ts';

// The `api` role (A§5): Hono on :8080 as mjk_api. The heartbeat is touched while the database
// answers, so `healthcheck` turns unhealthy when it does not; SIGTERM drains, then exits 0.

type Env = Readonly<Record<string, string | undefined>>;

export const API_PORT = 8080;
/** How long a drain waits for open requests before it closes their connections. */
export const DRAIN_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;
/** Above Caddy's upstream keep-alive (A§17.2). */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

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
  // Behind Caddy (A§17.2): an idle upstream connection must be closed by Caddy, never by Node, or
  // Caddy can reuse a connection at the moment Node closes it (a 502 that no api log shows). So
  // Node keeps it longer than Caddy's upstream keep-alive, which must stay below 65 s [U P1e], and
  // headersTimeout stays above keepAliveTimeout, as Node requires.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  await Promise.race([once(server, 'listening'), once(server, 'error').then(([err]) => Promise.reject(err))]);
  return server;
}

/** How often a drain closes the keep-alive connections that have gone idle since it began. */
const DRAIN_IDLE_POLL_MS = 100;

/** Stops accepting, lets open requests finish for up to `ms`, then closes what is left. */
export async function drain(server: Server, ms = DRAIN_MS): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // close() closes only the connections idle at that moment. One whose request finishes later would
  // stay open for keepAliveTimeout (65 s, longer than the drain), so each is closed once it is idle.
  server.closeIdleConnections();
  const idle = setInterval(() => server.closeIdleConnections(), DRAIN_IDLE_POLL_MS);
  const force = setTimeout(() => server.closeAllConnections(), ms);
  idle.unref();
  force.unref();
  await closed;
  clearInterval(idle);
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
  /** Test seam: the directory holding the file secrets (`app_keys`); `/run/secrets` in production. */
  secretsDir?: string;
};

/** The production wiring of the client-address rule and the Access JWT check (A§9, ADR-0004). */
export function edgeDeps(config: ApiConfig, logger: Logger): Pick<ApiDeps, 'clientAddress' | 'access' | 'site'> {
  return {
    site: { domain: config.domain, adminHost: config.adminHost },
    // The TCP peer of @hono/node-server's socket; the trusted peer is caddy's CADDY_PEER.
    clientAddress: { peer: (c) => getConnInfo(c).remote.address },
    access: {
      adminHost: config.adminHost,
      issuer: issuerOf(config.accessTeam),
      audience: config.accessAud,
      keys: createJwksCache({ url: certsUrlOf(config.accessTeam), logger }),
    },
  };
}

export async function runApi(env: Env, opts: ApiRunOpts): Promise<number> {
  const { logger } = opts;
  const config = readApiConfig(env);
  if (typeof config === 'string') {
    opts.log(`api: ${config}`);
    return EXIT_CONFIG;
  }
  // app_keys (A§17.3): read once at start; a missing or malformed key names the key, never a value.
  const keys = readAppKeys(opts.secretsDir);
  if (typeof keys === 'string') {
    opts.log(`api: ${keys}`);
    return EXIT_CONFIG;
  }
  // Loaded here, not at the top: `ssr` imports this module for listen, drain and pinger (and main.ts
  // imports every role), and must never load the account routes, which bring @simplewebauthn/server
  // and reflect-metadata's global patch (P2b code review; test/ssr/imports.test.ts).
  const { createApp } = await import('./create-app.ts');
  const pool = createPool('mjk_api', env, { max: API_POOL_MAX, statementTimeoutMs: API_STATEMENT_TIMEOUT_MS });
  if (typeof pool === 'string') {
    opts.log(`api: ${pool}`);
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  const ping = pinger(db);
  let server: Server;
  try {
    server = await listen(
      createApp({ db, logger, ping, keys, exportsDir: EXPORTS_DIR, ...edgeDeps(config, logger) }),
      opts.port ?? API_PORT,
      opts.hostname ?? '0.0.0.0',
    );
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
