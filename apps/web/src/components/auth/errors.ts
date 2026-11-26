import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { ApiError } from '../../lib/api.ts';
import { m } from '../../paraglide/messages.js';

// Every error code the auth and account routes answer has its own text in both languages (A§14).
// The message is chosen by name from a switch, never by a computed key (CLAUDE.md, Paraglide).

/** Which call failed: the same status means different things for each (e.g. 403 on a verify is "invite used up"). */
export type Ctx = 'signup' | 'verify' | 'password' | 'email' | 'plain';

/** A text and a text per field name; fields have no text when the server did not name them. */
export type Failure = { text: string; fields: Record<string, string> };

/** The person closed the "confirm it's you" step: nothing to show. */
export class ReauthCancelled extends Error {
  constructor() {
    super('reauth_cancelled');
  }
}

export function fieldText(name: string): string {
  switch (name) {
    case 'email':
      return m.auth_err_field_email();
    case 'invite':
      return m.auth_err_field_invite();
    case 'handle':
      return m.auth_err_field_handle();
    case 'display_name':
      return m.auth_err_field_display_name();
    case 'code':
      return m.auth_err_field_code();
    case 'password':
      return m.auth_err_field_password();
    case 'age_confirmed':
      return m.auth_err_field_age();
    case 'terms_version':
      return m.auth_err_field_terms();
    case 'altcha':
      return m.auth_err_field_altcha();
    default:
      return m.auth_err_field_generic();
  }
}

/** The fields a Zod issue list names (first path segment), each with its text. */
export function fieldsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const name = issue.path[0];
    if (typeof name === 'string') out[name] = fieldText(name);
  }
  return out;
}

const minutes = (retryAfter: number | null) => String(Math.max(1, Math.ceil((retryAfter ?? 60) / 60)));

function textOf(error: ApiError, ctx: Ctx): string {
  switch (error.code) {
    case 'bad_request':
    case 'invalid':
      return m.auth_err_bad_request();
    case 'unauthorized':
      if (ctx === 'password') return m.auth_err_password_wrong();
      return ctx === 'plain' ? m.auth_err_session() : m.auth_err_code_wrong();
    case 'forbidden':
      return ctx === 'verify' ? m.auth_err_invite_used() : m.auth_err_invite();
    case 'banned':
      return m.auth_err_banned();
    case 'conflict':
      if (ctx === 'signup') return m.auth_err_conflict_signup();
      return ctx === 'email' ? m.auth_err_conflict_email() : m.auth_err_conflict_verify();
    case 'rate_limited':
      return m.auth_err_rate_limited({ minutes: minutes(error.retryAfter) });
    case 'reauth_required':
      return m.auth_err_reauth();
    default:
      return m.auth_err_generic();
  }
}

export function describeError(error: unknown, ctx: Ctx): Failure {
  if (error instanceof ReauthCancelled) return { text: '', fields: {} };
  if (error instanceof ApiError) {
    const fields = Object.fromEntries(error.fields.map((name) => [name, fieldText(name)]));
    // A taken handle is the one 409 that names its field.
    if (ctx === 'signup' && error.code === 'conflict') fields.handle = m.auth_err_conflict_signup();
    return { text: textOf(error, ctx), fields };
  }
  // fetch() rejects with a TypeError when there is no connection; anything else is our own bug or a contract mismatch.
  return { text: error instanceof TypeError ? m.auth_err_network() : m.auth_err_generic(), fields: {} };
}

/** One request at a time: `run` clears the last failure, shows `busy` and turns a throw into `failure`. Resolves true on success. */
export function useAction(ctx: Ctx) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const run = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setFailure(null);
      try {
        await fn();
        return true;
      } catch (error) {
        setFailure(describeError(error, ctx));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [ctx],
  );
  return { busy, failure, setFailure, run };
}
