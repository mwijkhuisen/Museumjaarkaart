// The mail interface (A§9, ADR-0012). Plain text only: no HTML, so there is nothing a tracking pixel
// or a rewritten link could hide in. An error has a fixed code and never the address, the text or
// the provider's answer (invariant 8).

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** mail_unconfigured (no token or sender) and mail_refused (401, 403), mail_invalid (400, 422 and other 4xx): no retry. mail_unavailable (408, 409, 429, 5xx, timeout, network): retry. */
export type MailErrorCode = 'mail_unconfigured' | 'mail_refused' | 'mail_invalid' | 'mail_unavailable';

export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly retry: boolean;

  constructor(code: MailErrorCode) {
    super(code);
    this.name = 'MailError';
    this.code = code;
    this.retry = code === 'mail_unavailable';
  }
}

/** A fake for tests: keeps every message in memory. */
export function memoryMailer(): { mailer: Mailer; sent(): MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    mailer: {
      async send(msg) {
        sent.push({ ...msg });
      },
    },
    sent: () => sent.map((m) => ({ ...m })),
  };
}
