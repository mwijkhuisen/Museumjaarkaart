import { DEFAULT_SETTINGS, type MeUser, Settings, SettingsPatch, TERMS_VERSION } from '@mjk/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/kysely.ts';
import type { SessionUser } from './session.ts';

// The member as the api shows them to themselves (GET /me, and the 200 of every sign-in; A§14).
// Stored settings may be partial or from an older shape: they are read leniently and completed
// with the defaults, so a stored value never makes an answer fail its contract.

export function settingsOf(stored: unknown): Settings {
  const parsed = SettingsPatch.safeParse(stored);
  return Settings.parse({ ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) });
}

export function toMeUser(u: SessionUser): MeUser {
  return {
    handle: u.handle,
    display_name: u.display_name,
    email: u.email,
    role: u.role,
    settings: settingsOf(u.settings),
    terms_current: u.terms_version === TERMS_VERSION,
    has_password: u.has_password,
    created_at: u.created_at.toISOString(),
  };
}

/** The SessionUser of an account by id (after a sign-in creates its session), or undefined. */
export async function loadUser(db: Db, id: string): Promise<SessionUser | undefined> {
  const row = await db
    .selectFrom('app_user')
    .select([
      'id',
      'email',
      'handle',
      'display_name',
      'role',
      'settings',
      'terms_version',
      'created_at',
      sql<boolean>`password_hash IS NOT NULL`.as('has_password'),
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    email: String(row.email),
    handle: String(row.handle),
    display_name: row.display_name,
    role: row.role as SessionUser['role'],
    settings: row.settings,
    terms_version: row.terms_version,
    has_password: row.has_password,
    created_at: row.created_at as Date,
  };
}
