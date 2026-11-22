import { test as base, expect } from '@playwright/test';

declare global {
  interface Window {
    __mjkCsp?: (report: string) => void;
    __mjkCspSkipped?: () => void;
  }
}

/** WebKit's console error for its own <select> report (see the guard). */
const WEBKIT_SELECT =
  "console error: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

/**
 * Chromium's own performance hint for the map on the image's software GL (SwiftShader): the map page alone, with no
 * test read-back, logs it as a console warning a few times per page (seen in P1d, Chromium 1.64.1's build). It says
 * nothing about our code, and WebKit never logs it.
 */
const GL_STALL =
  /^console warning: \[\.WebGL-[0-9a-fx]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/;

/**
 * The guard every spec uses. After each test that opened a page it asserts: no CSP violation, no request to a
 * host other than the base URL's host or `media.` + it (A§18), no console error or warning and no page error.
 * A spec that expects one (a 404 page's "Failed to load resource") lists it in `allowedConsole`.
 */
export const test = base.extend<{ allowedConsole: RegExp[]; guard: undefined }>({
  allowedConsole: [[], { option: true }],
  guard: [
    async ({ page, baseURL, allowedConsole, browserName }, use) => {
      const violations: string[] = [];
      const urls: string[] = [];
      const problems: string[] = [];
      let skipped = 0;
      // The bindings survive navigations.
      await page.exposeFunction('__mjkCsp', (report: string) => violations.push(report));
      await page.exposeFunction('__mjkCspSkipped', () => skipped++);
      await page.addInitScript((webkit: boolean) => {
        // WebKit (Playwright 1.64.1's build) reports its own rendering of every <select> as one inline style
        // attribute. It does so on a bare <select> on a static page with no script at all (reproduced in P1c),
        // and Chromium reports nothing. The CSP stays as it is: the guard skips that first report per <select>
        // element, in WebKit only, and as many of the console errors it logs with it (WEBKIT_SELECT). A style= of
        // ours on a <select> is a second report and still fails, and Chromium and the SSR scans (build.test.ts)
        // see every other.
        const select = new WeakSet<Element>();
        document.addEventListener('securitypolicyviolation', (e) => {
          const t = e.target;
          if (webkit && e.violatedDirective === 'style-src-attr' && t instanceof HTMLSelectElement && !select.has(t)) {
            select.add(t);
            window.__mjkCspSkipped?.();
            return;
          }
          window.__mjkCsp?.(`${e.violatedDirective} ${e.blockedURI}`);
        });
      }, browserName === 'webkit');
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
      const own = problems.filter((p) => !(p === WEBKIT_SELECT && skipped-- > 0) && !GL_STALL.test(p));
      expect(own, 'console errors and page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
