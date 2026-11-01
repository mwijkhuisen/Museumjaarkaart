import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

const messages = (locale: string): { smoke_title: string; smoke_heading: string } =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));

for (const { path, locale } of [
  { path: '/', locale: 'nl' },
  { path: '/en/', locale: 'en' },
]) {
  test(`smoke page ${path} (${locale})`, async ({ page, baseURL }) => {
    const expected = messages(locale);
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(e.violatedDirective);
      });
    });
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));

    const res = await page.goto(path);
    expect(res?.status()).toBe(200);

    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveText(expected.smoke_heading);
    expect(await page.title()).toBe(expected.smoke_title);
    await expect(html).toHaveAttribute('data-ready', '1');
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

    const host = new URL(baseURL ?? '').host;
    for (const url of urls) expect(new URL(url).host, url).toBe(host);
  });
}
