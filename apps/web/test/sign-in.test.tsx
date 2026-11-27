import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { CodeStep } from '../src/components/auth/CodeStep.tsx';
import { describeError, isCeremonyAborted, ReauthCancelled } from '../src/components/auth/errors.ts';
import { PasskeySignInView } from '../src/components/auth/PasskeySignIn.tsx';
import { Reauth } from '../src/components/auth/Reauth.tsx';
import { SignInMethods } from '../src/components/auth/SignInMethods.tsx';
import { SignUpForm } from '../src/components/auth/SignUpForm.tsx';
import { ApiError, createQueryClient } from '../src/lib/api.ts';
import type { Locale } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';

// The screens of P2a (WP12): the server render of the app-shell pages, and the forms rendered
// directly (a server render never gets past "Loading": the member is not known until the browser
// asks `GET /api/v1/me`, A§15.1).

const config = {
  brand: 'Testmerk',
  controller: 'Test Beheerder',
  contactEmail: 'info@mjk.test',
  media: 'https://media.mjk.test',
};

function page(path: string, locale: Locale): string {
  setLocale(locale, { reload: false });
  return renderToStaticMarkup(<App path={path} queryClient={createQueryClient()} config={config} />);
}

const form = (locale: Locale, initialInvite = '') => {
  setLocale(locale, { reload: false });
  return renderToStaticMarkup(<SignUpForm locale={locale} initialInvite={initialInvite} onSignedIn={() => {}} />);
};

/** Every <input> that is not hidden has a <label for=its id>. */
function expectLabelled(html: string, hiddenTypes: string[] = []) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((x) => x[0]);
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) {
    if (hiddenTypes.some((t) => input.includes(`type="${t}"`))) continue;
    const id = /\bid="([^"]+)"/.exec(input)?.[1];
    expect(id, input).toBeDefined();
    expect(html, input).toContain(`<label for="${id}">`);
  }
}

describe.each([
  { locale: 'nl', signin: '/inloggen', account: '/account', h1: 'Inloggen', accountH1: 'Account', loading: 'Laden…' },
  {
    locale: 'en',
    signin: '/en/sign-in',
    account: '/en/account',
    h1: 'Sign in',
    accountH1: 'Account',
    loading: 'Loading…',
  },
] as const)('the app-shell pages in $locale', ({ locale, signin, account, h1, accountH1, loading }) => {
  it('the sign-in page renders its heading and the loading state only, with no inline style', () => {
    const html = page(signin, locale);
    expect(html).not.toContain('style=');
    expect(html).toContain(`<h1>${h1}</h1>`);
    expect(html).toContain(loading);
    // Nothing that depends on the member, the URL fragment or the widget before the browser asks.
    expect(html).not.toMatch(/<form|<input|altcha/i);
  });

  it('the account page renders its heading and the loading state only', () => {
    const html = page(account, locale);
    expect(html).not.toContain('style=');
    expect(html).toContain(`<h1>${accountH1}</h1>`);
    expect(html).toContain(loading);
    expect(html).not.toMatch(/<form|<input|@/);
  });

  it('every page has the same neutral account link in the header, whoever looks', () => {
    expect(page(locale === 'nl' ? '/' : '/en/', locale)).toContain(`<a href="${account}">Account</a>`);
  });
});

describe.each([
  { locale: 'nl', terms: '/voorwaarden', privacy: '/privacy' },
  { locale: 'en', terms: '/en/terms', privacy: '/en/privacy' },
] as const)('the sign-up form in $locale', ({ locale, terms, privacy }) => {
  const html = form(locale);

  it('has no inline style and a visible label on every input', () => {
    expect(html).not.toContain('style=');
    expectLabelled(html);
  });

  it('links the terms and the privacy notice, in a new tab so the form survives', () => {
    expect(html).toContain(`href="${terms}" target="_blank" rel="noopener"`);
    expect(html).toContain(`href="${privacy}" target="_blank" rel="noopener"`);
  });

  it('puts the honeypot in an aria-hidden, off-screen (class) wrapper, out of the tab order', () => {
    const wrapper = /<div class="hp" aria-hidden="true">(.*?)<\/div>/s.exec(html);
    expect(wrapper).not.toBeNull();
    const input = /<input\b[^>]*>/.exec(wrapper?.[1] ?? '')?.[0] ?? '';
    expect(input).toContain('name="mjk_hp_field"');
    expect(input).toContain('tabindex="-1"');
    expect(input).toMatch(/autocomplete="off"/i);
    // No name or id that autofill fills (a person's autofill would trip it and get no mail).
    expect(input).not.toMatch(/\b(name|id)="[^"]*(website|url|homepage)/i);
    expect(html.match(/name="mjk_hp_field"/g)).toHaveLength(1);
    // It is the only thing in the form that is hidden.
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(1);
  });

  it('has the invite, the 16+ box and the terms box, and a submit button that waits for the widget', () => {
    expect(html).toContain('name="invite"');
    expect(html).toContain('name="age_confirmed"');
    expect(html).toContain('name="terms"');
    expect(html).toMatch(/<button type="submit" class="button" disabled="">/);
  });

  it('carries the invite from the fragment into its field', () => {
    expect(form(locale, 'ABCD-EFGH')).toContain('value="ABCD-EFGH"');
  });

  it('shows the handle rules and does not render the widget before it is loaded', () => {
    expect(html).toMatch(/3 (tot|to) 30/);
    expect(html).not.toContain('altcha-widget');
  });
});

describe('every form posts', () => {
  // A programmatic form.submit() fires no submit event, so React's preventDefault never runs: a GET
  // form would put the email or the password in the URL. Only the router's search form is a GET.
  it('the rendered sign-up form and code step carry method="post"', () => {
    setLocale('nl', { reload: false });
    const code = renderToStaticMarkup(
      <CodeStep locale="nl" email="a@example.org" purpose="signin" onVerified={() => {}} onBack={() => {}} />,
    );
    for (const html of [form('nl'), code]) {
      const forms = html.match(/<form\b[^>]*>/g) ?? [];
      expect(forms.length).toBeGreaterThan(0);
      for (const f of forms) expect(f).toContain('method="post"');
    }
  });

  it('every <form> under src has method="post", except the GET search form of the router', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tsx'));
    let seen = 0;
    for (const f of files) {
      for (const tag of readFileSync(join(root, f), 'utf8').match(/<form\b[^>]*>/g) ?? []) {
        seen += 1;
        if (f.endsWith(join('lib', 'router.tsx'))) expect(tag).toContain('method="get"');
        else expect(tag, f).toContain('method="post"');
      }
    }
    expect(seen).toBeGreaterThanOrEqual(9);
  });
});

describe('the code step', () => {
  it('is a numeric one-time-code field with a label', () => {
    setLocale('nl', { reload: false });
    const html = renderToStaticMarkup(
      <CodeStep locale="nl" email="a@example.org" purpose="signin" onVerified={() => {}} onBack={() => {}} />,
    );
    expect(html).toMatch(/inputMode="numeric"|inputmode="numeric"/);
    expect(html).toMatch(/autoComplete="one-time-code"|autocomplete="one-time-code"/);
    expectLabelled(html);
    expect(html).toContain('a@example.org');
  });

  it('escapes an email that is hostile text', () => {
    setLocale('nl', { reload: false });
    const html = renderToStaticMarkup(
      <CodeStep
        locale="nl"
        email="<img src=x onerror=alert(1)>"
        purpose="signup"
        onVerified={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('every error code has its own text in both languages', () => {
  const codes = [
    'bad_request',
    'unauthorized',
    'forbidden',
    'banned',
    'conflict',
    'invalid',
    'rate_limited',
    'reauth_required',
    'internal',
  ];
  it.each(['nl', 'en'] as const)('%s: a non-empty text per code and context, none is an untranslated key', (locale) => {
    setLocale(locale, { reload: false });
    for (const ctx of ['signup', 'verify', 'password', 'email', 'plain'] as const) {
      for (const code of codes) {
        const { text } = describeError(new ApiError(400, code, [], null), ctx);
        expect(text, `${ctx} ${code}`).not.toBe('');
        expect(text, `${ctx} ${code}`).not.toMatch(/^[a-z_]+$/);
      }
    }
  });

  it('turns Retry-After into whole minutes, at least one', () => {
    setLocale('nl', { reload: false });
    expect(describeError(new ApiError(429, 'rate_limited', [], 600), 'plain').text).toContain('10 min');
    expect(describeError(new ApiError(429, 'rate_limited', [], 61), 'plain').text).toContain('2 min');
    expect(describeError(new ApiError(429, 'rate_limited', [], 5), 'plain').text).toContain('1 min');
    expect(describeError(new ApiError(429, 'rate_limited', [], 3_600), 'plain').text).toContain('60 min');
  });

  it('turns a wait over an hour (a day\u2019s limit) into whole hours', () => {
    setLocale('nl', { reload: false });
    expect(describeError(new ApiError(429, 'rate_limited', [], 3_601), 'passkey_add').text).toContain('2 uur');
    setLocale('en', { reload: false });
    expect(describeError(new ApiError(429, 'rate_limited', [], 80_000), 'passkey_add').text).toContain('23 hours');
  });

  it('names the field a 422 or a taken handle is about', () => {
    setLocale('en', { reload: false });
    const invalid = describeError(new ApiError(422, 'invalid', ['age_confirmed', 'handle'], null), 'signup');
    expect(Object.keys(invalid.fields)).toEqual(['age_confirmed', 'handle']);
    expect(describeError(new ApiError(409, 'conflict', [], null), 'signup').fields.handle).toContain('taken');
  });

  it('shows a network text for a failed fetch and nothing for a cancelled confirmation', () => {
    setLocale('en', { reload: false });
    expect(describeError(new TypeError('Failed to fetch'), 'plain').text).toContain('connection');
    expect(describeError(new ReauthCancelled(), 'plain')).toEqual({ text: '', fields: {} });
  });
});

describe('the passkey screens (P2b)', () => {
  const methods = (locale: Locale) => {
    setLocale(locale, { reload: false });
    return renderToStaticMarkup(<SignInMethods locale={locale} onSignedIn={() => {}} />);
  };

  it.each(['nl', 'en'] as const)('%s: both email fields of the sign-in carry the webauthn autofill token', (locale) => {
    const html = methods(locale);
    expect(html).not.toContain('style=');
    expectLabelled(html);
    // The code form's field, then the password form's field; no other input has the token.
    expect(html).toMatch(/<input\b[^>]*autoComplete="email webauthn"/i);
    expect(html).toMatch(/<input\b[^>]*autoComplete="username webauthn"/i);
    expect(html.match(/webauthn/gi)).toHaveLength(2);
    // A password field never autofills passkeys itself.
    expect(html).toMatch(/<input\b[^>]*type="password"[^>]*autoComplete="current-password"/i);
    for (const f of html.match(/<form\b[^>]*>/g) ?? []) expect(f).toContain('method="post"');
  });

  it.each(['nl', 'en'] as const)(
    '%s: Reauth has no webauthn token and, on the server, no passkey section (it appears client side only)',
    (locale) => {
      setLocale(locale, { reload: false });
      for (const hasPassword of [false, true]) {
        const html = renderToStaticMarkup(
          <Reauth
            locale={locale}
            email="a@example.org"
            hasPassword={hasPassword}
            onDone={() => {}}
            onCancel={() => {}}
          />,
        );
        expect(html).not.toMatch(/webauthn|passkey/i);
        expect(html).not.toContain('style=');
      }
    },
  );

  it.each(['nl', 'en'] as const)(
    '%s: the passkey section is a labelled section with one button and no form',
    (locale) => {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(<PasskeySignInView busy={false} failure={null} onClick={() => {}} />);
      expect(html).not.toContain('style=');
      expect(html).toContain('aria-labelledby="signin-passkey"');
      expect(html.match(/<button\b/g)).toHaveLength(1);
      expect(html).toContain('type="button"');
      expect(html).not.toMatch(/<form|<input/);
      const failed = renderToStaticMarkup(
        <PasskeySignInView busy failure={{ text: '<b>x</b>', fields: {} }} onClick={() => {}} />,
      );
      expect(failed).toContain('role="alert"');
      expect(failed).toContain('disabled=""');
      expect(failed).not.toContain('<b>');
    },
  );

  it('renders nothing for the passkey section on the server (it appears once the browser is known to support it)', () => {
    setLocale('nl', { reload: false });
    expect(methods('nl')).not.toContain('signin-passkey');
  });
});

describe('passkey errors have their own text in both languages', () => {
  const codes = [
    'bad_request',
    'unauthorized',
    'forbidden',
    'banned',
    'conflict',
    'invalid',
    'not_found',
    'rate_limited',
    'reauth_required',
    'internal',
  ];
  // By the exception's name, never its message (the library's WebAuthnError carries its cause's name).
  const ceremony = [
    'NotAllowedError',
    'InvalidStateError',
    'ConstraintError',
    'NotSupportedError',
    'SecurityError',
    'UnknownError',
    'PasskeyUnusable',
  ];
  const ctxs = ['passkey_signin', 'passkey_add', 'passkey_manage'] as const;
  const named = (name: string) => Object.assign(new Error('platform text'), { name });

  it.each(['nl', 'en'] as const)(
    '%s: a non-empty text for every code and ceremony error in every passkey context',
    (locale) => {
      setLocale(locale, { reload: false });
      for (const ctx of ctxs) {
        for (const code of codes) {
          const { text } = describeError(new ApiError(400, code, [], null), ctx);
          expect(text, `${ctx} ${code}`).not.toBe('');
          expect(text, `${ctx} ${code}`).not.toMatch(/^[a-z_]+$/);
        }
        for (const name of ceremony) {
          const { text } = describeError(named(name), ctx);
          expect(text, `${ctx} ${name}`).not.toBe('');
          expect(text, `${ctx} ${name}`).not.toMatch(/^[a-z_]+$/);
          expect(text, `${ctx} ${name}: never the platform's own message`).not.toContain('platform text');
        }
      }
    },
  );

  it('says what happened for the cases a member can act on', () => {
    setLocale('en', { reload: false });
    expect(describeError(new ApiError(401, 'unauthorized', [], null), 'passkey_signin').text).toContain('did not work');
    expect(describeError(named('NotAllowedError'), 'passkey_signin').text).toContain('cancelled or timed out');
    expect(describeError(named('NotAllowedError'), 'passkey_add').text).toContain('cancelled or timed out');
    expect(describeError(named('InvalidStateError'), 'passkey_add').text).toContain('already has a passkey');
    expect(describeError(new ApiError(409, 'conflict', [], null), 'passkey_add').text).toContain('20');
    expect(describeError(new ApiError(422, 'invalid', ['response'], null), 'passkey_add').text).toContain('verify');
    expect(describeError(new ApiError(404, 'not_found', [], null), 'passkey_manage').text).toContain('no longer');
    expect(describeError(new ApiError(429, 'rate_limited', [], 125), 'passkey_signin').text).toContain('3 min');
    expect(describeError(new ApiError(403, 'banned', [], null), 'passkey_signin').text).toContain('blocked');
    expect(describeError(new TypeError('Failed to fetch'), 'passkey_signin').text).toContain('connection');
    expect(describeError(new ApiError(422, 'invalid', ['name'], null), 'passkey_manage').fields.name).toContain(
      '1 to 50',
    );
  });

  it.each(['nl', 'en'] as const)('%s: passkey_reauth has its own fixed texts, by status and by ceremony', (locale) => {
    setLocale(locale, { reload: false });
    for (const code of codes) {
      const { text } = describeError(new ApiError(400, code, [], null), 'passkey_reauth');
      expect(text, code).not.toBe('');
      expect(text, code).not.toMatch(/^[a-z_]+$/);
    }
    for (const name of ceremony) {
      const { text } = describeError(named(name), 'passkey_reauth');
      expect(text, name).not.toBe('');
      expect(text, name).not.toContain('platform text');
    }
    expect(describeError(new ApiError(429, 'rate_limited', [], 125), 'passkey_reauth').text).toContain('3');
    expect(describeError(new TypeError('Failed to fetch'), 'passkey_reauth').text).not.toBe(
      describeError(new ApiError(401, 'unauthorized', [], null), 'passkey_reauth').text,
    );
    // The cancelled text is the reauth one, not the sign-in's.
    expect(describeError(named('NotAllowedError'), 'passkey_reauth').text).not.toBe(
      describeError(named('NotAllowedError'), 'passkey_signin').text,
    );
    expect(describeError(named('AbortError'), 'passkey_reauth')).toEqual({ text: '', fields: {} });
    expect(
      describeError(new ApiError(401, 'unauthorized', [], null), 'passkey_reauth').text,
      'a 401 is not "wrong code"',
    ).not.toBe(describeError(new ApiError(401, 'unauthorized', [], null), 'verify').text);
  });

  it('says what happened for a passkey confirmation (en)', () => {
    setLocale('en', { reload: false });
    expect(describeError(new ApiError(401, 'unauthorized', [], null), 'passkey_reauth').text).toBe(
      "This passkey did not work, or it is not one of this account's passkeys. Try another one or use a code.",
    );
    expect(describeError(named('NotAllowedError'), 'passkey_reauth').text).toContain('cancelled or timed out');
    expect(describeError(new ApiError(429, 'rate_limited', [], 125), 'passkey_reauth').text).toContain('3 min');
    expect(describeError(new TypeError('Failed to fetch'), 'passkey_reauth').text).toContain('connection');
  });

  it('is silent for an aborted ceremony, and names it by the library marker or the exception name', () => {
    setLocale('en', { reload: false });
    const byCode = Object.assign(new Error('x'), { name: 'AbortError', code: 'ERROR_CEREMONY_ABORTED' });
    expect(describeError(byCode, 'passkey_signin')).toEqual({ text: '', fields: {} });
    expect(isCeremonyAborted(byCode)).toBe(true);
    expect(isCeremonyAborted(named('AbortError'))).toBe(true);
    expect(isCeremonyAborted(named('NotAllowedError'))).toBe(false);
    expect(isCeremonyAborted('AbortError')).toBe(false);
    expect(isCeremonyAborted(new ApiError(401, 'unauthorized', [], null))).toBe(false);
  });
});
