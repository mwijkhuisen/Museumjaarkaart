import { readSecret, SECRETS_DIR } from '../db/migrate.ts';
import { MailError, type Mailer, type MailMessage } from './mailer.ts';

// Lettermint's sending API (ADR-0012), read from Lettermint's public reference on 2026-11-26:
//   https://lettermint.co/docs/api-reference/sending/send
//   https://lettermint.co/docs/api-reference/sending/0.0.1/lettermint-sending-openapi.json
// - POST https://api.lettermint.co/v1/send, JSON body, auth header `x-lettermint-token: <project API token>`.
// - Body: `from` (string, "Name <addr>"), `to` (string[], at least one), `subject` (max 998 characters),
//   `text` (min 3 characters), optional `html`, `reply_to` (string[]), `settings` ({ track_opens, track_clicks,
//   tls }), `tag`, `metadata`, `headers`. Optional header `Idempotency-Key` (1 to 255 characters, 24 hours).
// - Success: 202 `{ message_id, status: "pending" }` (the answer is not read here). Documented errors:
//   401 (missing or bad token), 403, 409 (idempotency conflict), 422 (validation), 429, 500; 413 above 50 MB.
// We send `settings.track_opens` and `track_clicks` as false on every mail (A§2) and read no answer body: it
// is cancelled unread, so nothing the provider says can reach a log or an error.

export const LETTERMINT_URL = 'https://api.lettermint.co/v1/send';
export const TOKEN_SECRET = 'lettermint_api_token';
export const SEND_TIMEOUT_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

const TOKEN = /^[\x21-\x7e]{8,256}$/;
const ADDRESS = /^[^\s@<>",;:\\]{1,64}@[^\s@<>",;:\\]{1,190}\.[^\s@<>",;:\\]{2,63}$/;
// Characters that would break the `Name <address>` form or a header.
const BRAND = /^[^\p{Cc}<>",;:@\\]{1,100}$/u;

/** The mailer on Lettermint; the token file and the sender are read on every send, never held. */
export function lettermintMailer(env: Env, secretsDir = SECRETS_DIR): Mailer {
  return {
    async send(msg: MailMessage): Promise<void> {
      const token = readSecret(TOKEN_SECRET, secretsDir);
      const address = env.MJK_MAIL_FROM;
      const brand = env.MJK_BRAND_NAME;
      if (
        token === undefined ||
        !TOKEN.test(token) ||
        address === undefined ||
        !ADDRESS.test(address) ||
        brand === undefined ||
        !BRAND.test(brand.trim())
      ) {
        throw new MailError('mail_unconfigured');
      }
      let status: number;
      try {
        const res = await fetch(LETTERMINT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lettermint-token': token },
          body: JSON.stringify({
            from: `${brand.trim()} <${address}>`,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            settings: { track_opens: false, track_clicks: false },
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        status = res.status;
        await res.body?.cancel().catch(() => {});
      } catch {
        // A timeout, a refused redirect or the network: the message can quote the URL or the address.
        throw new MailError('mail_unavailable');
      }
      if (status === 202 || (status >= 200 && status < 300)) return;
      if (status === 401 || status === 403) throw new MailError('mail_refused');
      if (status === 408 || status === 409 || status === 429 || status >= 500) throw new MailError('mail_unavailable');
      throw new MailError('mail_invalid');
    },
  };
}
