import { type ApiApp, type ApiDeps, buildApp, type Mount, mountCatalogue } from './app.ts';
import { mountAuth } from './routes/auth.ts';
import { mountAuthPasskey } from './routes/auth-passkey.ts';
import { mountMe } from './routes/me.ts';
import { mountMeExports } from './routes/me-exports.ts';
import { mountMeImports } from './routes/me-imports.ts';
import { mountMeMuseums } from './routes/me-museums.ts';
import { mountMePasskeys } from './routes/me-passkeys.ts';
import { mountMeProgress } from './routes/me-progress.ts';
import { mountMeVisits } from './routes/me-visits.ts';
import { mountMeWishlist } from './routes/me-wishlist.ts';
import { mountMedia } from './routes/media.ts';
import { mountPassword } from './routes/password.ts';
import { mountReviews } from './routes/reviews.ts';
import { mountUploads } from './routes/uploads.ts';

// The `api` role's own app: the catalogue plus the account routes. Only the api role loads this
// module (runApi imports it when it starts), never `ssr`: the passkey routes bring
// @simplewebauthn/server and, through it, reflect-metadata's patch of the global `Reflect`
// (P2b code review; test/ssr/imports.test.ts). The ssr's in-process app is buildApp + mountCatalogue.

/**
 * The account routes (P2a, passkeys P2b, the passport P2c, uploads P3b): only on the `api` role's own app, with its keys and site
 * (runApi), never on the ssr's in-process app, which mounts the catalogue alone.
 */
export const mountAccounts: Mount = (v1, d) => {
  mountAuth(v1, d);
  mountPassword(v1, d);
  mountAuthPasskey(v1, d);
  mountMe(v1, d);
  mountMePasskeys(v1, d);
  mountMeVisits(v1, d);
  mountMeWishlist(v1, d);
  mountMeMuseums(v1, d);
  mountMeProgress(v1, d);
  mountMeImports(v1, d);
  mountMeExports(v1, d);
  mountReviews(v1, d);
  mountUploads(v1, d);
  mountMedia(v1, d);
};

export function createApp(deps: ApiDeps): ApiApp {
  return buildApp(deps, (v1, d) => {
    mountCatalogue(v1, d);
    if (d.keys !== undefined && d.site !== undefined) mountAccounts(v1, d);
  });
}
