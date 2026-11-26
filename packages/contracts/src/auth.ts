import { z } from 'zod';
import { IsoDateTime } from './common.ts';

// Accounts, sessions and the auth routes (P2a; A§9, A§10, A§14). Browser-safe: zod only.
// Every request schema is strict, so an unknown key is a 400 (A§14). Values that a later check
// refuses with 422 (the 16+ box, the terms version, a reserved handle) are plain types here.

/** The current terms version (a constant until P3d versions `/voorwaarden`). */
export const TERMS_VERSION = '2026-11-27';

export const LOCALES = ['nl', 'en'] as const;
export const ROLES = ['user', 'moderator', 'admin'] as const;
export const SESSION_HOSTS = ['public', 'admin'] as const;
export const SESSION_METHODS = ['code', 'password', 'passkey'] as const;
export const CODE_PURPOSES = ['signup', 'signin', 'email_change', 'delete'] as const;

export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
/** Handles nobody may take (A§10): staff-like names and the card's name (ADR-0006). */
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'administrator',
  'api',
  'beheer',
  'beheerder',
  'contact',
  'help',
  'info',
  'mail',
  'me',
  'mod',
  'moderator',
  'museumjaarkaart',
  'museumkaart',
  'null',
  'privacy',
  'root',
  'security',
  'staff',
  'support',
  'system',
  'team',
  'undefined',
  'www',
];

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const DISPLAY_NAME_MAX = 50;
export const EMAIL_MAX = 254;

/**
 * An email, normalised once here (trimmed, lower-cased) and stored in that form, so the limiter's
 * keys and the database's citext lookups always see the same value (design 4). zod's email rule
 * accepts ASCII addresses only.
 */
export const Email = z.string().trim().toLowerCase().max(EMAIL_MAX).pipe(z.email());
export const Handle = z.string().regex(HANDLE_RE);
/** 1–50 code points, no control, line-separator or bidi-control characters (A§18 hostile strings). */
export const DisplayName = z
  .string()
  .trim()
  .regex(/^[^\p{Cc}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]{1,50}$/u);
export const Password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
export const Locale = z.enum(LOCALES);
export const Role = z.enum(ROLES);
export const Code = z.string().regex(/^[0-9]{6}$/);
/** The ALTCHA widget's payload (base64 of its JSON); altcha-lib parses and verifies it. */
export const AltchaPayload = z.string().min(1).max(4096);

/**
 * An invite code: 16 characters of Crockford base32 (A§9). Typed input is normalised the
 * Crockford way: case-insensitive, hyphens and spaces dropped, I and L read as 1, O as 0.
 */
export const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;
export function normaliseInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}
export const InviteCode = z.string().max(40).transform(normaliseInviteCode).pipe(z.string().regex(INVITE_CODE_RE));

/** A§10 settings, as stored (every key optional; the server fills the defaults on read). */
export const SettingsPatch = z.strictObject({
  visits_visibility: z.enum(['private', 'public']).optional(),
  wishlist_visibility: z.enum(['private', 'public']).optional(),
  hide_ratings_until_visited: z.boolean().optional(),
  card_type: z.enum(['adult', 'under_19']).optional(),
  locale: Locale.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const Settings = z.strictObject({
  visits_visibility: z.enum(['private', 'public']),
  wishlist_visibility: z.enum(['private', 'public']),
  hide_ratings_until_visited: z.boolean(),
  card_type: z.enum(['adult', 'under_19']),
  locale: Locale,
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  visits_visibility: 'private',
  wishlist_visibility: 'private',
  hide_ratings_until_visited: false,
  card_type: 'adult',
  locale: 'nl',
};

// ---- Requests -------------------------------------------------------------------------------

/** POST /auth/signup. `website` is the honeypot: a person leaves it empty. */
export const SignupRequest = z.strictObject({
  invite: InviteCode,
  email: Email,
  handle: Handle,
  display_name: DisplayName,
  age_confirmed: z.boolean(),
  terms_version: z.string().max(40),
  altcha: AltchaPayload,
  locale: Locale,
  website: z.string().max(500).optional(),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/** POST /auth/code: in P2a only `signin` (`delete` arrives with P3d). */
export const CodeRequest = z.strictObject({
  email: Email,
  purpose: z.literal('signin'),
  altcha: AltchaPayload,
  locale: Locale,
});
export type CodeRequest = z.infer<typeof CodeRequest>;

/** POST /auth/code/verify. `altcha` is required only above the site-wide failure threshold. */
export const CodeVerifyRequest = z.strictObject({
  email: Email,
  purpose: z.enum(['signin', 'signup']),
  code: Code,
  altcha: AltchaPayload.optional(),
});
export type CodeVerifyRequest = z.infer<typeof CodeVerifyRequest>;

/** POST /auth/password. */
export const PasswordSignInRequest = z.strictObject({ email: Email, password: Password });
export type PasswordSignInRequest = z.infer<typeof PasswordSignInRequest>;

/** PUT /me/password. */
export const PasswordSetRequest = z.strictObject({ password: Password });
export type PasswordSetRequest = z.infer<typeof PasswordSetRequest>;

/** POST /me/email: a code to the new address. */
export const EmailChangeRequest = z.strictObject({ email: Email, locale: Locale });
export type EmailChangeRequest = z.infer<typeof EmailChangeRequest>;

/** POST /me/email/verify. */
export const EmailVerifyRequest = z.strictObject({ code: Code });
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequest>;

/** PATCH /me: at least one of the two. */
export const MePatchRequest = z
  .strictObject({ display_name: DisplayName.optional(), settings: SettingsPatch.optional() })
  .refine((v) => v.display_name !== undefined || v.settings !== undefined, { path: ['display_name'] });
export type MePatchRequest = z.infer<typeof MePatchRequest>;

// ---- Answers --------------------------------------------------------------------------------

/** GET /auth/altcha: altcha-lib's v2 challenge for SHA-256, signed per host. */
export const AltchaChallenge = z.strictObject({
  parameters: z.strictObject({
    algorithm: z.literal('SHA-256'),
    cost: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    keyLength: z.number().int().positive(),
    keyPrefix: z.string().regex(/^[0-9a-f]{1,64}$/),
    nonce: z.string().regex(/^[0-9a-f]{1,128}$/),
    salt: z.string().regex(/^[0-9a-f]{1,128}$/),
  }),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AltchaChallenge = z.infer<typeof AltchaChallenge>;

/** Every 202 (a mail or a job follows). */
export const Accepted = z.strictObject({ accepted: z.literal(true) });
export type Accepted = z.infer<typeof Accepted>;

export const MeUser = z.strictObject({
  handle: Handle,
  display_name: z.string(),
  email: z.string(),
  role: Role,
  settings: Settings,
  terms_current: z.boolean(),
  has_password: z.boolean(),
  created_at: IsoDateTime,
});
export type MeUser = z.infer<typeof MeUser>;

/** GET /me (200 with `user: null` when signed out), and the 200 of every sign-in. */
export const Me = z.strictObject({ user: MeUser.nullable() });
export type Me = z.infer<typeof Me>;

export const SessionItem = z.strictObject({
  ref: z.uuid(),
  host: z.enum(SESSION_HOSTS),
  method: z.enum(SESSION_METHODS),
  created_at: IsoDateTime,
  last_used_at: IsoDateTime,
  current: z.boolean(),
});
export type SessionItem = z.infer<typeof SessionItem>;

/** GET /me/sessions: a member's own sessions, newest first (few, so unpaged). */
export const SessionList = z.strictObject({ items: z.array(SessionItem).max(1000) });
export type SessionList = z.infer<typeof SessionList>;

/** GET /api/admin/me. */
export const AdminMe = z.strictObject({ handle: Handle, role: z.enum(['moderator', 'admin']) });
export type AdminMe = z.infer<typeof AdminMe>;
