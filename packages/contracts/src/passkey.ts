import { z } from 'zod';
import { DisplayName } from './auth.ts';
import { IsoDateTime } from './common.ts';

// Passkeys (P2b; A§9, A§14). Browser-safe: zod only. The web projects every WebAuthn answer of
// @simplewebauthn/browser onto the fixed shapes below before sending it, so the request schemas can
// stay strict (an unknown key is a 400) without refusing an authenticator or a password manager
// that adds its own extension outputs. Every binary field is canonical, unpadded base64url: one
// spelling per byte string, so the server's decode and the library's decode cannot disagree.

/** A§8: at most this many passkeys per member [U: the beta tunes it]; the next one is a 409. */
export const PASSKEY_MAX = 20;
/** The authenticator transports WebAuthn names (Level 3); the server keeps only these. */
export const PASSKEY_TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
export type PasskeyTransport = (typeof PASSKEY_TRANSPORTS)[number];

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * True for canonical unpadded base64url: only the 64 characters, no length that leaves a lone
 * character, and the unused low bits of the last character zero (so each byte string has exactly
 * one spelling). The empty string is canonical (zero bytes).
 */
export function isCanonicalBase64url(s: string): boolean {
  if (s.length % 4 === 1) return false;
  for (let i = 0; i < s.length; i++) if (B64URL.indexOf(s[i] as string) === -1) return false;
  const last = B64URL.indexOf(s[s.length - 1] ?? 'A');
  if (s.length % 4 === 2) return (last & 0x0f) === 0;
  if (s.length % 4 === 3) return (last & 0x03) === 0;
  return true;
}

/** Canonical base64url of 1 to `maxBytes` bytes. */
const Bytes = (maxBytes: number) =>
  z
    .string()
    .min(2)
    .max(Math.ceil((maxBytes * 4) / 3))
    .refine(isCanonicalBase64url);

/** A credential id: 1 to 1023 bytes (WebAuthn's cap). */
export const CredentialId = Bytes(1023);
/** A passkey's name: plain text with the display name's rules (1–50 code points, no control or bidi characters). */
export const PasskeyName = DisplayName;

// ---- Requests --------------------------------------------------------------------------------

/** The assertion of a discoverable credential (`userHandle` is therefore required). */
export const PasskeyAssertion = z
  .strictObject({
    id: CredentialId,
    rawId: CredentialId,
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: Bytes(4096),
      authenticatorData: Bytes(2048),
      signature: Bytes(1024),
      userHandle: Bytes(64),
    }),
  })
  .refine((c) => c.id === c.rawId, { path: ['rawId'] });
export type PasskeyAssertion = z.infer<typeof PasskeyAssertion>;

/** POST /auth/passkey/verify. */
export const PasskeySignInRequest = z.strictObject({ credential: PasskeyAssertion });
export type PasskeySignInRequest = z.infer<typeof PasskeySignInRequest>;

/**
 * The assertion of a re-authentication: the browser was given the member's own credentials
 * (`allowCredentials`), and an authenticator may then leave `userHandle` out. When it is there, the
 * server still checks it.
 */
export const PasskeyReauthAssertion = z
  .strictObject({
    id: CredentialId,
    rawId: CredentialId,
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: Bytes(4096),
      authenticatorData: Bytes(2048),
      signature: Bytes(1024),
      userHandle: Bytes(64).optional(),
    }),
  })
  .refine((c) => c.id === c.rawId, { path: ['rawId'] });
export type PasskeyReauthAssertion = z.infer<typeof PasskeyReauthAssertion>;

/** POST /auth/passkey/reauth/verify. */
export const PasskeyReauthRequest = z.strictObject({ credential: PasskeyReauthAssertion });
export type PasskeyReauthRequest = z.infer<typeof PasskeyReauthRequest>;

/** A new credential: the attestation, the transports the browser reported and `credProps.rk`. */
export const PasskeyAttestation = z
  .strictObject({
    id: CredentialId,
    rawId: CredentialId,
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: Bytes(4096),
      attestationObject: Bytes(12_288),
      transports: z.array(z.string().min(1).max(32)).max(16).optional(),
    }),
    rk: z.boolean().optional(),
  })
  .refine((c) => c.id === c.rawId, { path: ['rawId'] });
export type PasskeyAttestation = z.infer<typeof PasskeyAttestation>;

/** POST /me/passkeys. */
export const PasskeyRegisterRequest = z.strictObject({ credential: PasskeyAttestation, name: PasskeyName.optional() });
export type PasskeyRegisterRequest = z.infer<typeof PasskeyRegisterRequest>;

/** PATCH /me/passkeys/:ref. */
export const PasskeyRenameRequest = z.strictObject({ name: PasskeyName });
export type PasskeyRenameRequest = z.infer<typeof PasskeyRenameRequest>;

// ---- Answers --------------------------------------------------------------------------------

const Challenge = Bytes(128);
const Timeout = z.number().int().positive().max(600_000);

/** POST /auth/passkey/options: a discoverable sign-in, so no credential list (the autofill UI). */
export const PasskeySignInOptions = z.strictObject({
  challenge: Challenge,
  rpId: z.string().min(1).max(253),
  timeout: Timeout,
  userVerification: z.literal('required'),
});
export type PasskeySignInOptions = z.infer<typeof PasskeySignInOptions>;

/** A credential the browser may use: in excludeCredentials (registration) and allowCredentials (re-authentication). */
const CredentialDescriptor = z.strictObject({
  id: CredentialId,
  type: z.literal('public-key'),
  transports: z.array(z.enum(PASSKEY_TRANSPORTS)).max(8).optional(),
});

/** POST /auth/passkey/reauth/options: only the signed-in member's own passkeys, so the browser offers no other account's. */
export const PasskeyReauthOptions = z.strictObject({
  challenge: Challenge,
  rpId: z.string().min(1).max(253),
  timeout: Timeout,
  userVerification: z.literal('required'),
  allowCredentials: z.array(CredentialDescriptor).min(1).max(PASSKEY_MAX),
});
export type PasskeyReauthOptions = z.infer<typeof PasskeyReauthOptions>;

/** POST /me/passkeys/options: PublicKeyCredentialCreationOptionsJSON as we fill it (A§9). */
export const PasskeyRegistrationOptions = z.strictObject({
  challenge: Challenge,
  rp: z.strictObject({ id: z.string().min(1).max(253), name: z.string().min(1).max(253) }),
  user: z.strictObject({ id: Bytes(64), name: z.string().min(1).max(64), displayName: z.string().min(1).max(64) }),
  pubKeyCredParams: z
    .array(z.strictObject({ alg: z.number().int(), type: z.literal('public-key') }))
    .min(1)
    .max(8),
  timeout: Timeout,
  attestation: z.literal('none'),
  excludeCredentials: z.array(CredentialDescriptor).max(PASSKEY_MAX),
  authenticatorSelection: z.strictObject({
    residentKey: z.literal('required'),
    requireResidentKey: z.literal(true),
    userVerification: z.literal('required'),
  }),
  extensions: z.strictObject({ credProps: z.literal(true) }),
});
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptions>;

/** A member's passkey as the account page lists it: never the key, the credential id, the transports or the counter. */
export const PasskeyItem = z.strictObject({
  ref: z.uuid(),
  name: z.string().nullable(),
  created_at: IsoDateTime,
  last_used_at: IsoDateTime.nullable(),
  backed_up: z.boolean(),
});
export type PasskeyItem = z.infer<typeof PasskeyItem>;

/** GET /me/passkeys: newest first, unpaged (at most PASSKEY_MAX). */
export const PasskeyList = z.strictObject({ items: z.array(PasskeyItem).max(PASSKEY_MAX) });
export type PasskeyList = z.infer<typeof PasskeyList>;
