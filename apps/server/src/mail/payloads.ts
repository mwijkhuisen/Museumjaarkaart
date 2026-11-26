import { z } from 'zod';
import { seal } from '../auth/crypto.ts';
import type { AppKeys } from '../auth/keys.ts';
import type { Db } from '../db/kysely.ts';
import { enqueueIn } from '../worker/queue.ts';
import type { Locale } from './templates.ts';

// The mail jobs' payloads (A§8, A§9): ids plus the one exception to "ids only", values sealed with
// AES-256-GCM under `code_seal`, with the kind and the row's id (the email_code, invite or user) in the
// associated data, so a sealed value cannot be moved to another row or kind (the job's id is not known
// before the insert). The helpers enqueue inside the caller's transaction, so the row they belong to
// and the job commit together. The worker deletes the job on success, so a sealed value never outlives it.

export const MAIL_CODE_JOB = 'mail_code';
export const MAIL_INVITE_JOB = 'mail_invite';
export const MAIL_NOTICE_JOB = 'mail_notice';

const LocaleSchema = z.enum(['nl', 'en']);
const Id = z.uuid();
const Sealed = z.string().max(1024).nullable();

export const MailCodePayload = z.strictObject({ email_code_id: Id, locale: LocaleSchema, sealed: Sealed });
export const MailInvitePayload = z.strictObject({
  invite_id: Id,
  locale: LocaleSchema,
  sealed_code: Sealed,
  sealed_to: Sealed,
});
export const MailNoticePayload = z.strictObject({ user_id: Id, locale: LocaleSchema, sealed_to: Sealed });

export const aad = {
  code: (emailCodeId: string) => `mail_code:${emailCodeId}`,
  inviteCode: (inviteId: string) => `mail_invite:code:${inviteId}`,
  inviteTo: (inviteId: string) => `mail_invite:to:${inviteId}`,
  noticeTo: (userId: string) => `mail_notice:to:${userId}`,
};

/** A code lives 10 minutes and the backoff starts at 15: a retry is useless, the member asks again. */
export function enqueueMailCode(
  trx: Db,
  keys: AppKeys,
  a: { emailCodeId: string; code: string; locale: Locale },
): Promise<string> {
  return enqueueIn(
    trx,
    MAIL_CODE_JOB,
    {
      email_code_id: a.emailCodeId,
      locale: a.locale,
      sealed: seal(keys.code_seal, a.code, aad.code(a.emailCodeId)),
    },
    { maxAttempts: 1 },
  );
}

export function enqueueMailInvite(
  trx: Db,
  keys: AppKeys,
  a: { inviteId: string; code: string; to: string; locale: Locale },
): Promise<string> {
  return enqueueIn(
    trx,
    MAIL_INVITE_JOB,
    {
      invite_id: a.inviteId,
      locale: a.locale,
      sealed_code: seal(keys.code_seal, a.code, aad.inviteCode(a.inviteId)),
      sealed_to: seal(keys.code_seal, a.to, aad.inviteTo(a.inviteId)),
    },
    {},
  );
}

export function enqueueMailNotice(
  trx: Db,
  keys: AppKeys,
  a: { userId: string; to: string; locale: Locale },
): Promise<string> {
  return enqueueIn(
    trx,
    MAIL_NOTICE_JOB,
    { user_id: a.userId, locale: a.locale, sealed_to: seal(keys.code_seal, a.to, aad.noticeTo(a.userId)) },
    {},
  );
}
