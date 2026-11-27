import { describe, expect, it } from 'vitest';
import { type Locale, type MailKind, render, type TemplateData } from '../../src/mail/templates.ts';

// Fixed texts only (A§9): the brand, the domain and the code or invite link go in, nothing submitted does.

// Built at run time: the brand is configuration, never a literal under apps/.
const BRAND = ['Test', 'Brand'].join('');
const DOMAIN = 'example.test';
const CODE = '123456';
const INVITE = '0123456789ABCDEF';
const base = { brand: BRAND, domain: DOMAIN };

const cases: [MailKind, Partial<TemplateData>][] = [
  ['code_signin', { code: CODE }],
  ['code_signup', { code: CODE }],
  ['code_email_change', { code: CODE }],
  ['invite', { code: INVITE, validUntil: '2026-12-31' }],
  ['email_changed', { contact: 'help@example.test' }],
  ['passkey_added', { contact: 'help@example.test' }],
];

describe.each(['nl', 'en'] as const)('%s', (locale: Locale) => {
  it.each(cases)('%s holds the brand and its code or link', (kind, extra) => {
    const { subject, text } = render(kind, locale, { ...base, ...extra });
    expect(subject).toContain(BRAND);
    expect(text).toContain(BRAND);
    if (kind.startsWith('code_')) {
      expect(text).toContain(CODE);
      expect(text).toMatch(locale === 'nl' ? /10 minuten/ : /10 minutes/);
      expect(subject).not.toContain(CODE);
    }
    if (kind === 'invite') {
      expect(text).toContain(INVITE);
      expect(text).toContain(
        locale === 'nl'
          ? `https://${DOMAIN}/inloggen#uitnodiging=${INVITE}`
          : `https://${DOMAIN}/en/sign-in#invite=${INVITE}`,
      );
      expect(text).toContain('2026-12-31');
    }
    if (kind === 'email_changed' || kind === 'passkey_added') expect(text).toContain('help@example.test');
    if (kind === 'passkey_added') {
      expect(subject).toMatch(/passkey/);
      expect(text).toMatch(locale === 'nl' ? /verwijder de passkey/ : /remove the passkey/);
    }
  });

  it.each(cases)('%s ignores submitted text it has no field for', (kind, extra) => {
    // A caller (or a bug) that passes a handle, a display name or markup along: none of it may appear.
    const hostile = { handle: '</script>', display_name: 'Eve <b>Evil</b>', newEmail: 'new@evil.test' };
    const clean = render(kind, locale, { ...base, ...extra });
    const dirty = render(kind, locale, { ...base, ...extra, ...hostile } as TemplateData);
    expect(dirty).toEqual(clean);
    const all = `${dirty.subject}\n${dirty.text}`;
    expect(all).not.toMatch(/script|Evil|evil\.test/);
    expect(all).not.toContain('<');
  });
});

it('refuses data that is not what the template takes, without quoting it', () => {
  for (const data of [
    { ...base, code: '12345' },
    { ...base, code: '1234567' },
    { ...base, code: '12345a' },
    { ...base },
    { ...base, brand: 'bad\nbrand', code: CODE },
    { ...base, domain: 'EXAMPLE.test/x', code: CODE },
  ]) {
    expect(() => render('code_signin', 'en', data)).toThrow('template: invalid data');
  }
  expect(() => render('invite', 'en', { ...base, code: 'short', validUntil: '2026-12-31' })).toThrow();
  expect(() => render('invite', 'en', { ...base, code: INVITE, validUntil: 'soon' })).toThrow();
  expect(() => render('email_changed', 'en', { ...base })).toThrow();
  expect(() => render('passkey_added', 'en', { ...base })).toThrow();
  expect(() => render('passkey_added', 'nl', { ...base, contact: 'not an address' })).toThrow();
  expect(() => render('code_signin', 'fr' as Locale, { ...base, code: CODE })).toThrow();
});

it('the email_changed notice holds no address but the contact', () => {
  const { text } = render('email_changed', 'en', { ...base, contact: 'help@example.test' });
  expect(text.match(/\S+@\S+/g)).toEqual(['help@example.test.']);
});

it('the passkey_added notice holds no address but the contact, and no link', () => {
  for (const locale of ['nl', 'en'] as const) {
    const { subject, text } = render('passkey_added', locale, { ...base, contact: 'help@example.test' });
    expect(text.match(/\S+@\S+/g)).toEqual(['help@example.test.']);
    expect(`${subject}\n${text}`).not.toMatch(/https?:\/\//);
  }
});
