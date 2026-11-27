import { AltchaChallenge } from '@mjk/contracts';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type ApiDeps, buildApp } from '../../src/api/app.ts';
import { mountAccounts } from '../../src/api/create-app.ts';
import type { ApiEnv } from '../../src/api/middleware/request.ts';
import { open } from '../../src/auth/crypto.ts';
import type { AppKeys } from '../../src/auth/keys.ts';
import { SESSION_COOKIE } from '../../src/auth/session.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { aad } from '../../src/mail/payloads.ts';
import type { AuthDb } from './fixtures.ts';
import { makeTestKeys } from './test-keys.ts';

// The account routes over app.request(), as the api serves them: the keys, the site, a client
// address per request (the test-only `x-test-peer` header; `none` means unknown), and, on the admin
// host, an Access identity from the test-only `x-test-access` header (the real JWT check is
// covered by access-jwt.test.ts and admin-host.int.test.ts). Neither header exists in production.

export const SITE = { domain: 'mjk.test', adminHost: 'admin.mjk.test' };

const testAccess: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const email = c.req.header('x-test-access');
  if (email !== undefined) c.set('access', { email });
  await next();
};

export type Req = {
  method?: string;
  body?: unknown;
  host?: string;
  peer?: string;
  cookie?: string;
  headers?: Record<string, string>;
};

export function accountsApp(a: AuthDb, opts: { keys?: AppKeys } = {}) {
  const keys = opts.keys ?? makeTestKeys();
  const { logger, lines } = memoryLogger('api');
  const deps: ApiDeps = {
    db: a.db,
    logger,
    ping: async () => true,
    keys,
    site: SITE,
    clientAddress: {
      peer: (c: Context) => {
        const p = c.req.header('x-test-peer');
        return p === 'none' ? undefined : (p ?? '192.0.2.1');
      },
    },
  };
  // The test identity must exist before the session middleware reads it, so it wraps the whole app.
  const app = new Hono<ApiEnv>();
  app.use('*', testAccess);
  app.route('/', buildApp(deps, mountAccounts));
  const req = async (path: string, r: Req = {}) => {
    const host = r.host ?? 'mjk.test';
    const body = r.body === undefined ? undefined : JSON.stringify(r.body);
    const headers: Record<string, string> = {
      host,
      'sec-fetch-site': 'same-origin',
      'x-test-peer': r.peer ?? '192.0.2.1',
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...(r.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${r.cookie}` }),
      ...r.headers,
    };
    return app.request(`http://${host}/api/v1${path}`, {
      method: r.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
    });
  };
  return { app, keys, lines, req, deps };
}

/** Solves a real challenge from GET /auth/altcha, as the widget does, and returns its payload. */
export async function altchaPayload(req: ReturnType<typeof accountsApp>['req'], host = 'mjk.test'): Promise<string> {
  const r = await req('/auth/altcha', { host });
  const challenge = AltchaChallenge.parse(await r.json());
  const solution = await solveChallenge({ challenge, deriveKey });
  if (solution === null) throw new Error('altcha: no solution');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

/** The clear code of the newest mail_code job for `email` and `purpose`, opened with the keys (tests only). */
export async function codeFor(a: AuthDb, keys: AppKeys, email: string, purpose = 'signin'): Promise<string> {
  const r = await a.admin.query<{ id: string; sealed: string }>(
    `SELECT e.id, j.payload->>'sealed' AS sealed FROM job j JOIN email_code e ON e.id = (j.payload->>'email_code_id')::uuid
     WHERE j.kind = 'mail_code' AND e.email = $1 AND e.purpose = $2 ORDER BY j.id DESC LIMIT 1`,
    [email, purpose],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error('no mail_code job');
  const code = open(keys.code_seal, row.sealed, aad.code(row.id));
  if (code === null) throw new Error('seal');
  return code;
}

/** The session token from a Set-Cookie header. */
export const tokenOf = (res: Response): string | null => {
  const m = /__Host-mjk_sid=([A-Za-z0-9_-]{43});/.exec(res.headers.get('set-cookie') ?? '');
  return m?.[1] ?? null;
};
