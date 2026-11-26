import { sql } from 'kysely';
import type { z } from 'zod';
import { open } from '../auth/crypto.ts';
import type { AppKeys } from '../auth/keys.ts';
import type { Db } from '../db/kysely.ts';
import type { Logger } from '../lib/log.ts';
import { countMailSent, mailCap, nearCap } from '../mail/budget.ts';
import { MailError, type Mailer } from '../mail/mailer.ts';
import {
  aad,
  MAIL_CODE_JOB,
  MAIL_INVITE_JOB,
  MAIL_NOTICE_JOB,
  MailCodePayload,
  MailInvitePayload,
  MailNoticePayload,
} from '../mail/payloads.ts';
import { type Locale, type MailKind, render, type TemplateData } from '../mail/templates.ts';
import { JobError, type JobHandler } from './types.ts';

// The mail jobs (A§9, A§17.7, ADR-0012). A job opens its sealed values, renders a fixed text, sends it and
// resolves `'consumed'`, so the worker deletes the row: no sealed value outlives the send. A mail that must
// not go out (the drop rules below) is consumed too. Nothing here logs an address, a code, a subject or a
// text; logs hold fixed codes, ids and counts.

type Env = Readonly<Record<string, string | undefined>>;
export type MailDeps = { db: Db; keys: AppKeys; mailer: Mailer; logger: Logger; env: Env };

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const r = schema.safeParse(payload);
  if (!r.success) throw new JobError('mail_payload_invalid', { retry: false });
  return r.data;
}

function unseal(key: Buffer, sealed: string | null, aadText: string): string {
  const v = sealed === null ? null : open(key, sealed, aadText);
  if (v === null) throw new JobError('seal_invalid', { retry: false });
  return v;
}

export function mailJobs(deps: MailDeps): Record<string, JobHandler> {
  const { db, keys, mailer, logger, env } = deps;

  const base = (): Pick<TemplateData, 'brand' | 'domain'> => {
    const { MJK_BRAND_NAME: brand, MJK_DOMAIN: domain } = env;
    if (brand === undefined || domain === undefined) throw new JobError('mail_unconfigured', { retry: false });
    return { brand, domain };
  };

  /** Render, send, count; a failure is a JobError with a fixed code. Resolves `'consumed'`. */
  async function deliver(to: string, kind: MailKind, locale: Locale, data: Partial<TemplateData>): Promise<'consumed'> {
    let rendered: ReturnType<typeof render>;
    try {
      rendered = render(kind, locale, { ...base(), ...data });
    } catch (err) {
      if (err instanceof JobError) throw err;
      throw new JobError('mail_render_failed', { retry: false });
    }
    try {
      await mailer.send({ to, subject: rendered.subject, text: rendered.text });
    } catch (err) {
      if (err instanceof MailError) throw new JobError(err.code, { retry: err.retry });
      throw new JobError('mail_unavailable', { retry: true });
    }
    // The mail is out: a failure to count it must not fail the job (a retry would send it again).
    try {
      const count = await countMailSent(db);
      const cap = mailCap(env);
      if (cap !== undefined && nearCap(count, cap)) logger.warn({ count, cap }, 'mail_cap_near');
    } catch {
      logger.error({}, 'mail_count_failed');
    }
    return 'consumed';
  }

  const mailCode: JobHandler = async (payload) => {
    const p = parse(MailCodePayload, payload);
    const row = await db
      .selectFrom('email_code')
      .select(['email', 'purpose', sql<boolean>`expires_at <= now()`.as('expired')])
      .where('id', '=', p.email_code_id)
      .executeTakeFirst();
    // Missing or expired: nothing is sent, and the sealed code goes with the job.
    if (row === undefined) return 'consumed';
    const drop = async () => {
      await db.deleteFrom('email_code').where('id', '=', p.email_code_id).execute();
      return 'consumed' as const;
    };
    if (row.expired) return drop();
    const user = await db.selectFrom('app_user').select('status').where('email', '=', row.email).executeTakeFirst();
    // No mail for an address without an account (sign-in) or with one already (sign-up, email change).
    if (row.purpose === 'signin' && user?.status !== 'active') return drop();
    if ((row.purpose === 'signup' || row.purpose === 'email_change') && user !== undefined) return drop();
    const kind: MailKind | undefined =
      row.purpose === 'signin'
        ? 'code_signin'
        : row.purpose === 'signup'
          ? 'code_signup'
          : row.purpose === 'email_change'
            ? 'code_email_change'
            : undefined;
    // ponytail: the deletion confirmation (purpose `delete`, A§13.5) has no template yet; it arrives with its feature.
    if (kind === undefined) throw new JobError('mail_purpose_unsupported', { retry: false });
    const code = unseal(keys.code_seal, p.sealed, aad.code(p.email_code_id));
    return deliver(row.email, kind, p.locale, { code });
  };

  const mailInvite: JobHandler = async (payload) => {
    const p = parse(MailInvitePayload, payload);
    const invite = await db
      .selectFrom('invite')
      .select([
        sql<boolean>`expires_at <= now()`.as('expired'),
        sql<string>`(expires_at AT TIME ZONE 'Europe/Amsterdam')::date::text`.as('until'),
      ])
      .where('id', '=', p.invite_id)
      .executeTakeFirst();
    if (invite === undefined || invite.expired) return 'consumed';
    const code = unseal(keys.code_seal, p.sealed_code, aad.inviteCode(p.invite_id));
    const to = unseal(keys.code_seal, p.sealed_to, aad.inviteTo(p.invite_id));
    return deliver(to, 'invite', p.locale, { code, validUntil: invite.until });
  };

  const mailNotice: JobHandler = async (payload) => {
    const p = parse(MailNoticePayload, payload);
    const to = unseal(keys.code_seal, p.sealed_to, aad.noticeTo(p.user_id));
    const contact = env.MJK_CONTACT_EMAIL;
    if (contact === undefined) throw new JobError('mail_unconfigured', { retry: false });
    return deliver(to, 'email_changed', p.locale, { contact });
  };

  return { [MAIL_CODE_JOB]: mailCode, [MAIL_INVITE_JOB]: mailInvite, [MAIL_NOTICE_JOB]: mailNotice };
}
