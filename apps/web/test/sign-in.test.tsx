import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { CodeStep } from '../src/components/auth/CodeStep.tsx';
import { describeError, ReauthCancelled } from '../src/components/auth/errors.ts';
import { SignUpForm } from '../src/components/auth/SignUpForm.tsx';
import { ApiError, createQueryClient } from '../src/lib/api.ts';
import type { Locale } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';

// The screens of P2a (WP12): the server render of the app-shell pages, and the forms rendered
// directly (a server render never gets past "Loading": the member is not known until the browser
// asks `GET /api/v1/me`, A§15.1).

const config = { brand: 'Testmerk', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' };

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
