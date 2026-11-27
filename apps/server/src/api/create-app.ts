import { type ApiApp, type ApiDeps, buildApp, type Mount, mountCatalogue } from './app.ts';
import { mountAuth } from './routes/auth.ts';
import { mountAuthPasskey } from './routes/auth-passkey.ts';
import { mountMe } from './routes/me.ts';
import { mountMePasskeys } from './routes/me-passkeys.ts';
import { mountPassword } from './routes/password.ts';

// The `api` role's own app: the catalogue plus the account routes. Only the api role loads this
// module (runApi imports it when it starts), never `ssr`: the passkey routes bring
// @simplewebauthn/server and, through it, reflect-metadata's patch of the global `Reflect`
// (P2b code review; test/ssr/imports.test.ts). The ssr's in-process app is buildApp + mountCatalogue.

/**
 * The account routes (P2a, passkeys P2b): only on the `api` role's own app, with its keys and site
 * (runApi), never on the ssr's in-process app, which mounts the catalogue alone.
 */
export const mountAccounts: Mount = (v1, d) => {
  mountAuth(v1, d);
  mountPassword(v1, d);
  mountAuthPasskey(v1, d);
  mountMe(v1, d);
  mountMePasskeys(v1, d);
};

export function createApp(deps: ApiDeps): ApiApp {
  return buildApp(deps, (v1, d) => {
    mountCatalogue(v1, d);
    if (d.keys !== undefined && d.site !== undefined) mountAccounts(v1, d);
  });
}
