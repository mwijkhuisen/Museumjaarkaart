// The mail texts (A§9, ADR-0012, ADR-0013): fixed text in NL and EN, plain text. A code mail holds the
// code and fixed text only: the data has no field for a handle, a display name or any other submitted
// text, so none can reach a mail. The brand and the domain come from the configuration, never from here.

export type Locale = 'nl' | 'en';
export type MailKind =
  | 'code_signin'
  | 'code_signup'
  | 'code_email_change'
  | 'invite'
  | 'email_changed'
  | 'passkey_added';

export type TemplateData = {
  brand: string;
  domain: string;
  /** The 6-digit code, or the invite code. */
  code?: string;
  /** The invite's last day, an ISO date. */
  validUntil?: string;
  /** The contact address of `email_changed` and `passkey_added`. */
  contact?: string;
};

export type Rendered = { subject: string; text: string };

const SIX = /^\d{6}$/;
const INVITE = /^[0-9A-Z]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const WORD = /^[^\p{Cc}]{1,100}$/u;
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}$/;

/** Thrown before any text is built; the message is fixed and quotes no value. */
function bad(): never {
  throw new Error('template: invalid data');
}

const CODE_TEXT = {
  code_signin: {
    nl: (b: string) => ({ subject: `Je inlogcode voor ${b}`, lead: `Je code om in te loggen bij ${b}:` }),
    en: (b: string) => ({ subject: `Your ${b} sign-in code`, lead: `Your code to sign in to ${b}:` }),
  },
  code_signup: {
    nl: (b: string) => ({
      subject: `Je code om een account bij ${b} te maken`,
      lead: `Je code om een account bij ${b} te maken:`,
    }),
    en: (b: string) => ({
      subject: `Your code to create a ${b} account`,
      lead: `Your code to create a ${b} account:`,
    }),
  },
  code_email_change: {
    nl: (b: string) => ({
      subject: `Je code om je e-mailadres bij ${b} te wijzigen`,
      lead: `Je code om je nieuwe e-mailadres bij ${b} te bevestigen:`,
    }),
    en: (b: string) => ({
      subject: `Your code to change your ${b} email address`,
      lead: `Your code to confirm your new ${b} email address:`,
    }),
  },
} as const;

export function render(kind: MailKind, locale: Locale, data: TemplateData): Rendered {
  const { brand, domain } = data;
  if (locale !== 'nl' && locale !== 'en') bad();
  if (!WORD.test(brand) || !HOST.test(domain)) bad();
  const nl = locale === 'nl';

  if (kind === 'code_signin' || kind === 'code_signup' || kind === 'code_email_change') {
    if (data.code === undefined || !SIX.test(data.code)) bad();
    const { subject, lead } = CODE_TEXT[kind][locale](brand);
    const text = nl
      ? `${lead}\n\n${data.code}\n\nDe code is 10 minuten geldig. Heb je dit niet aangevraagd? Dan kun je deze e-mail negeren.\n\n${brand} · ${domain}\n`
      : `${lead}\n\n${data.code}\n\nThe code is valid for 10 minutes. Did you not ask for it? Then you can ignore this email.\n\n${brand} · ${domain}\n`;
    return { subject, text };
  }

  if (kind === 'invite') {
    if (data.code === undefined || !INVITE.test(data.code)) bad();
    if (data.validUntil === undefined || !DAY.test(data.validUntil)) bad();
    const link = nl
      ? `https://${domain}/inloggen#uitnodiging=${data.code}`
      : `https://${domain}/en/sign-in#invite=${data.code}`;
    return nl
      ? {
          subject: `Je uitnodiging voor ${brand}`,
          text: `Je bent uitgenodigd voor ${brand}.\n\nJe uitnodigingscode: ${data.code}\n\nOf open deze link om je aan te melden:\n${link}\n\nDe uitnodiging is geldig tot ${data.validUntil}.\n\n${brand} · ${domain}\n`,
        }
      : {
          subject: `Your invitation to ${brand}`,
          text: `You have been invited to ${brand}.\n\nYour invite code: ${data.code}\n\nOr open this link to sign up:\n${link}\n\nThe invitation is valid until ${data.validUntil}.\n\n${brand} · ${domain}\n`,
        };
  }

  const contact = data.contact;
  if (contact === undefined || !ADDRESS.test(contact)) bad();

  // passkey_added (P2b, owner 2026-11-27): to the account's address, the member's alarm for a passkey
  // planted through a stolen session (A§16.2). It names no passkey, device or other submitted text, and
  // holds no link (a notice that teaches members to click mail links helps a phisher).
  if (kind === 'passkey_added') {
    return nl
      ? {
          subject: `Er is een passkey toegevoegd aan je ${brand}-account`,
          text: `Er is een passkey toegevoegd aan je account bij ${brand}. Daarmee kun je voortaan inloggen zonder code.\n\nWas jij dit niet? Log dan in, verwijder de passkey op je accountpagina (daarmee log je ook je andere sessies uit) en neem contact op via ${contact}.\n\n${brand} · ${domain}\n`,
        }
      : {
          subject: `A passkey was added to your ${brand} account`,
          text: `A passkey was added to your account at ${brand}. It can be used to sign in without a code.\n\nWas this not you? Sign in, remove the passkey on your account page (this also signs out your other sessions) and contact ${contact}.\n\n${brand} · ${domain}\n`,
        };
  }

  // email_changed: to the old address. It names neither the new address nor anything else submitted.
  return nl
    ? {
        subject: `Het e-mailadres van je ${brand}-account is gewijzigd`,
        text: `Het e-mailadres van je account bij ${brand} is gewijzigd. Vanaf nu gaan e-mails naar het nieuwe adres.\n\nWas jij dit niet? Neem dan contact op via ${contact}.\n\n${brand} · ${domain}\n`,
      }
    : {
        subject: `The email address of your ${brand} account was changed`,
        text: `The email address of your account at ${brand} was changed. From now on emails go to the new address.\n\nWas this not you? Contact ${contact}.\n\n${brand} · ${domain}\n`,
      };
}
