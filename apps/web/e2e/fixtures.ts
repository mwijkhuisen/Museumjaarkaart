import { test as base, expect } from '@playwright/test';

declare global {
  interface Window {
    __cspViolations: string[];
    __mjkCsp?: (report: string) => void;
  }
}

/**
 * The guard every spec uses. After each test that opened a page it asserts: no CSP violation, no request to a
 * host other than the base URL's host or `media.` + it (A§18), no console error or warning and no page error.
 * A spec that expects one (a 404 page's "Failed to load resource") lists it in `allowedConsole`.
 */
export const test = base.extend<{ allowedConsole: RegExp[]; guard: undefined }>({
  allowedConsole: [[], { option: true }],
  guard: [
    async ({ page, baseURL, allowedConsole }, use) => {
      const violations: string[] = [];
      const urls: string[] = [];
      const problems: string[] = [];
      // The binding survives navigations; window.__cspViolations lives for one document.
      await page.exposeFunction('__mjkCsp', (report: string) => violations.push(report));
      await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__cspViolations.push(e.violatedDirective);
          window.__mjkCsp?.(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      page.on('request', (req) => urls.push(req.url()));
      page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !allowedConsole.some((re) => re.test(m.text())))
          problems.push(`console ${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

      await use(undefined);

      const host = new URL(baseURL ?? '').host;
      const allowed = new Set([host, `media.${host}`]);
      const offHost = urls.filter((u) => /^(https?|wss?):/.test(u) && !allowed.has(new URL(u).host));
      expect(violations, 'CSP violations').toEqual([]);
      expect(offHost, 'requests to other hosts').toEqual([]);
      expect(problems, 'console errors and page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
