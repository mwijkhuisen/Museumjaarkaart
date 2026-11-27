import type { ApiApp, ApiDeps } from '../app.ts';

// The member's passkeys (P2b WP3; A§9, A§14): GET /me/passkeys, POST /me/passkeys/options,
// POST /me/passkeys, PATCH and DELETE /me/passkeys/:ref. The WebAuthn work is in auth/webauthn.ts.

export function mountMePasskeys(_v1: ApiApp, deps: ApiDeps): void {
  if (deps.keys === undefined || deps.site === undefined) throw new Error('me_passkeys_need_keys_and_site');
}
