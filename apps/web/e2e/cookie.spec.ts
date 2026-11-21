import { expect, test } from './fixtures.ts';

// A§18: the __Host- session cookie needs Secure over https. The edge stands in for Cloudflare; both
// engines must accept and send back a Secure, HttpOnly __Host- cookie on https://mjk.test.
test('a __Host- Secure HttpOnly cookie round-trips', async ({ page, context }) => {
  await page.goto('/__e2e/cookie/set');
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-mjk_probe');
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/' });
  await page.goto('/__e2e/cookie/echo');
  await expect(page.locator('body')).toContainText('__Host-mjk_probe=1');
});
