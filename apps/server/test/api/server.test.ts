import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { http, passthrough } from 'msw';
import { expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { drain, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, listen } from '../../src/api/server.ts';

// listen() and drain() on a real socket (WP3): SIGTERM lets an open request finish, then the
// server stops accepting. msw intercepts every request, so this file lets loopback through.

it('drain lets an open request finish, then refuses new connections', async () => {
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  const app = new Hono();
  app.get('/slow', async (c) => {
    entered();
    await held;
    return c.text('done');
  });
  const server = await listen(app, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const open = fetch(`${base}/slow`);
  await inside;
  const drained = drain(server, 4_000);
  release();
  const r = await open;
  expect(r.status).toBe(200);
  expect(await r.text()).toBe('done');
  // The keep-alive connection went idle after close(): the drain closes it at once, never waiting
  // for keepAliveTimeout (65 s) or the force timer.
  const t0 = performance.now();
  await drained;
  expect(performance.now() - t0).toBeLessThan(1_000);
  await expect(fetch(`${base}/slow`)).rejects.toThrow();
});

it('listen rejects when the port is taken', async () => {
  const app = new Hono();
  const first = await listen(app, 0, '127.0.0.1');
  const port = (first.address() as AddressInfo).port;
  await expect(listen(app, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  await drain(first, 1_000);
});

it('keeps an idle connection 65 s, longer than Caddy upstream keep-alive (A§17.2)', async () => {
  const server = await listen(new Hono(), 0, '127.0.0.1');
  expect(KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
  expect(HEADERS_TIMEOUT_MS).toBe(66_000);
  expect(server.keepAliveTimeout).toBe(65_000);
  expect(server.headersTimeout).toBe(66_000);
  expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  await drain(server, 1_000);
});
