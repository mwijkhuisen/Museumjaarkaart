import pg from 'pg';
import { type DbLogin, dbUrl } from './migrate.ts';

// One pg pool per process and login (A§8). The URL comes from dbUrl(): a file
// secret in production, DATABASE_URL in development and tests.

type Env = Readonly<Record<string, string | undefined>>;

/** Pool sizes per process [U]: the worker holds 3 connections, the admin CLI 2, the api 10. */
export const WORKER_POOL_MAX = 3;
export const ADMIN_POOL_MAX = 2;
export const API_POOL_MAX = 10;
/** The api's per-statement cap [U]: a public read never runs longer. */
export const API_STATEMENT_TIMEOUT_MS = 5_000;

const OID_DATE = 1082;

/**
 * A `date` column is a plain `YYYY-MM-DD` string, never a JS Date: a Date is
 * parsed in the local time zone and shifts the day. `int8` stays a string.
 */
const types = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === OID_DATE && format !== 'binary' ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text'),
} as pg.CustomTypesConfig;

/** The pool of a login, or an error text (never the secret) when its URL cannot be built. */
export function createPool(
  login: DbLogin,
  env: Env,
  opts: { max: number; secretsDir?: string; statementTimeoutMs?: number },
): pg.Pool | string {
  const url = dbUrl(login, env, opts.secretsDir);
  if (typeof url === 'string') return url;
  const pool = new pg.Pool({
    connectionString: url.href,
    application_name: login,
    max: opts.max,
    connectionTimeoutMillis: 5_000,
    ...(opts.statementTimeoutMs === undefined ? {} : { statement_timeout: opts.statementTimeoutMs }),
    types,
  });
  // An idle client's error (a restart of the server) must not crash the process; the next query reconnects.
  // The message is dropped on purpose: it can quote the connection.
  pool.on('error', () => {});
  return pool;
}
