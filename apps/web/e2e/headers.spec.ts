import type { APIResponse } from '@playwright/test';
import { expect, test } from './fixtures.ts';

// A§15.6 on the public host. `<domain>` is the host of the base URL (deploy/e2e: mjk.test).
const domain = (baseURL: string | undefined) => new URL(baseURL ?? '').host;

const expectSiteHeaders = (res: APIResponse, host: string) => {
  const h = res.headers();
  expect(h['content-security-policy']).toBe(
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://media.${host}; media-src https://media.${host}; connect-src 'self' https://media.${host}; worker-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['permissions-policy']).toBe(
    'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()',
  );
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['cross-origin-resource-policy']).toBe('same-origin');
  expect(h.server).toBeUndefined();
  expect(h['set-cookie']).toBeUndefined();
};

test('a page carries the headers and a short shared cache', async ({ request, baseURL }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60');
});

test('an asset is immutable and carries the headers', async ({ request, baseURL }) => {
  const html = await (await request.get('/')).text();
  const asset = /\/assets\/[^"'\s]+\.js/.exec(html)?.[0];
  expect(asset, 'a script under /assets in the page').toBeDefined();
  const res = await request.get(asset as string);
  expect(res.status()).toBe(200);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('a missing asset is a no-store 404', async ({ request, baseURL }) => {
  const res = await request.get('/assets/nope.js');
  expect(res.status()).toBe(404);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('/api/admin is a 404 on the public host', async ({ request, baseURL }) => {
  const res = await request.get('/api/admin/x');
  expect(res.status()).toBe(404);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('the api keeps its own Cache-Control and gets the headers', async ({ request, baseURL }) => {
  const res = await request.get('/api/v1/healthz');
  expect(res.status()).toBe(200);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('a body over 64 KB is a no-store 413', async ({ request, baseURL }) => {
  const res = await request.post('/api/v1/museums', {
    headers: { 'content-type': 'application/json' },
    data: Buffer.alloc(64 * 1024 + 1, 'a'),
  });
  expect(res.status()).toBe(413);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('no-store');
});

// The second pass of stack.sh runs this with `ssr` stopped; the first pass skips it.
test('@ssr-down a page is a no-store 502 with the headers', async ({ request, baseURL }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(502);
  expectSiteHeaders(res, domain(baseURL));
  expect(res.headers()['cache-control']).toBe('no-store');
});
