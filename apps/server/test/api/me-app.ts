import { type ApiDeps, buildApp, type Mount } from '../../src/api/app.ts';
import { mountMe } from '../../src/api/routes/me.ts';
import type { AppKeys } from '../../src/auth/keys.ts';
import { SESSION_COOKIE, type SessionHost, startSession } from '../../src/auth/session.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import type { AuthDb } from '../auth/fixtures.ts';
import { makeTestKeys } from '../auth/test-keys.ts';

// The /me routes (or the routes `mount` adds; P2c's packages mount their own) through buildApp, as P2a's integration tests drive them: same-origin headers, an
// explicit Content-Length (app.request() sends none), the session cookie, and a client address we choose.

export const SITE = { domain: 'mjk.test', adminHost: 'admin.mjk.test' };

export function meApp(a: AuthDb, mount: Mount = mountMe, extra: Partial<ApiDeps> = {}) {
  const keys: AppKeys = makeTestKeys();
  const { logger, lines } = memoryLogger('api');
  const state: { peer: string | undefined } = { peer: '203.0.113.7' };
  const deps: ApiDeps = {
    db: a.db,
    logger,
    ping: async () => true,
    site: SITE,
    keys,
    clientAddress: { peer: () => state.peer },
    ...extra,
  };
  const app = buildApp(deps, mount);
  const call = (
    path: string,
    o: { method?: string; token?: string; body?: unknown; host?: string; raw?: string } = {},
  ) => {
    const text = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return app.request(`http://localhost/api/v1${path}`, {
      method: o.method ?? (text === undefined ? 'GET' : 'POST'),
      ...(text === undefined ? {} : { body: text }),
      headers: {
        host: o.host ?? SITE.domain,
        'Sec-Fetch-Site': 'same-origin',
        ...(text === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) }),
        ...(o.token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${o.token}` }),
      },
    });
  };
  const signIn = async (userId: string, host: SessionHost = 'public') =>
    (await startSession(a.db, { userId, host, method: 'code', sentToken: null })).token;
  return { app, keys, lines, state, call, signIn };
}
