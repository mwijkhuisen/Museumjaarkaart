import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { type ApiDeps, buildApp } from '../../src/api/app.ts';
import { readApiConfig } from '../../src/api/config.ts';
import {
  CADDY_PEER,
  type ClientAddressDeps,
  canonicalAddress,
  resolveClient,
  withPrefixes,
} from '../../src/api/middleware/client-address.ts';
import { drain, edgeDeps, listen } from '../../src/api/server.ts';
import type { Db } from '../../src/db/kysely.ts';
import { memoryLogger } from '../../src/lib/log.ts';

// The client-address rule (A§9, P1e criteria 3 and 4): `X-Mjk-Client` counts only when the TCP peer
// is caddy (10.63.2.10) and the header is one valid IP literal; from any other peer (ssr, a forged
// request) the peer's own address is the client. Then the limiter prefixes, and a real socket from a
// non-caddy peer through runApi's own wiring (conninfo). Neither the address nor a prefix is logged.

const SSR_PEER = '10.63.2.20';

function setup(clientAddress: ClientAddressDeps | undefined) {
  const { logger, lines } = memoryLogger('api');
  const deps: ApiDeps = { db: {} as Db, logger, ping: async () => true, ...(clientAddress ? { clientAddress } : {}) };
  const app = buildApp(deps, (v1) => {
    v1.get('/whoami', (c) => c.json({ client: c.var.client ?? null }));
  });
  return { app, lines };
}

const whoami = async (app: ReturnType<typeof setup>['app'], header?: string) => {
  const r = await app.request('http://mjk.test/api/v1/whoami', {
    headers: header === undefined ? {} : { 'X-Mjk-Client': header },
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { client: unknown }).client;
};

describe('canonicalAddress', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['::ffff:10.63.2.10', '10.63.2.10'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['::', '::'],
    ['64:ff9b::203.0.113.7', '64:ff9b::cb00:7107'],
  ])('%s → %s', (raw, canonical) => {
    expect(canonicalAddress(raw)).toBe(canonical);
  });

  it.each([
    '',
    ' 203.0.113.7',
    '203.0.113.7 ',
    '203.0.113.7, 198.51.100.1',
    '203.0.113.7:443',
    '[2001:db8::1]',
    'fe80::1%eth0',
    '010.1.1.1',
    '256.1.1.1',
    'example.com',
    'unknown',
    '1::2::3',
    '1.2.3.4\u{2028}',
  ])('%j is not one IP literal', (raw) => {
    expect(canonicalAddress(raw)).toBeNull();
  });
});

describe('withPrefixes', () => {
  it('IPv4: the /24, no /48', () => {
    expect(withPrefixes('203.0.113.7')).toEqual({ address: '203.0.113.7', prefix: '203.0.113.0/24', prefix48: null });
  });

  it('IPv6: the /56 and the /48', () => {
    expect(withPrefixes('2001:db8:abcd:12ff:1:2:3:4')).toEqual({
      address: '2001:db8:abcd:12ff:1:2:3:4',
      prefix: '2001:db8:abcd:1200::/56',
      prefix48: '2001:db8:abcd::/48',
    });
    expect(withPrefixes('2001:db8::1')).toMatchObject({ prefix: '2001:db8::/56', prefix48: '2001:db8::/48' });
  });
});

describe('resolveClient', () => {
  it('the header counts from caddy only', () => {
    expect(resolveClient(CADDY_PEER, '203.0.113.7', CADDY_PEER)).toBe('203.0.113.7');
    expect(resolveClient(`::ffff:${CADDY_PEER}`, '203.0.113.7', CADDY_PEER)).toBe('203.0.113.7');
    expect(resolveClient(SSR_PEER, '203.0.113.7', CADDY_PEER)).toBe(SSR_PEER);
    expect(resolveClient('10.63.2.100', '203.0.113.7', CADDY_PEER)).toBe('10.63.2.100');
    // From caddy a missing or invalid header leaves the client unknown (fail closed), never caddy itself.
    expect(resolveClient(CADDY_PEER, 'garbage', CADDY_PEER)).toBeNull();
    expect(resolveClient(CADDY_PEER, undefined, CADDY_PEER)).toBeNull();
    expect(resolveClient(CADDY_PEER, '', CADDY_PEER)).toBeNull();
    expect(resolveClient(CADDY_PEER, `${CADDY_PEER}, 203.0.113.7`, CADDY_PEER)).toBeNull();
    expect(resolveClient(undefined, '203.0.113.7', CADDY_PEER)).toBeNull();
  });
});

describe('the middleware', () => {
  const peerIs = (address: string | undefined): ClientAddressDeps => ({ peer: () => address });

  it('a forged X-Mjk-Client from a non-caddy peer (ssr) is ignored: the peer is the client', async () => {
    const { app } = setup(peerIs(SSR_PEER));
    expect(await whoami(app, '198.51.100.1')).toEqual({
      address: SSR_PEER,
      prefix: '10.63.2.0/24',
      prefix48: null,
    });
    expect(await whoami(app)).toMatchObject({ address: SSR_PEER });
  });

  it('a valid header from caddy is the client', async () => {
    const { app } = setup(peerIs(CADDY_PEER));
    expect(await whoami(app, '198.51.100.1')).toEqual({
      address: '198.51.100.1',
      prefix: '198.51.100.0/24',
      prefix48: null,
    });
    expect(await whoami(app, '2001:db8:1:2::9')).toEqual({
      address: '2001:db8:1:2::9',
      prefix: '2001:db8:1::/56',
      prefix48: '2001:db8:1::/48',
    });
  });

  it('a missing or invalid header from caddy leaves the client unset, never caddy itself or the header', async () => {
    const { app } = setup(peerIs(CADDY_PEER));
    for (const bad of ['', 'unknown', '198.51.100.1, 203.0.113.9', '198.51.100.1:80', 'x'.repeat(10_000)])
      expect(await whoami(app, bad), bad.slice(0, 40)).toBeNull();
    expect(await whoami(app)).toBeNull();
  });

  it('the IPv4-mapped form of the peer and of the header', async () => {
    const mapped = setup(peerIs(`::ffff:${CADDY_PEER}`));
    expect(await whoami(mapped.app, '::ffff:198.51.100.1')).toMatchObject({
      address: '198.51.100.1',
      prefix: '198.51.100.0/24',
    });
    const other = setup(peerIs('::ffff:10.63.2.20'));
    expect(await whoami(other.app, '198.51.100.1')).toMatchObject({ address: SSR_PEER });
  });

  it('an unknown peer leaves the client unset; a throwing peer lookup too', async () => {
    expect(await whoami(setup(peerIs(undefined)).app, '198.51.100.1')).toBeNull();
    const throwing = setup({
      peer: () => {
        throw new Error('no socket');
      },
    });
    expect(await whoami(throwing.app, '198.51.100.1')).toBeNull();
  });

  it('without the deps (the ssr in-process app) nothing is set', async () => {
    expect(await whoami(setup(undefined).app, '198.51.100.1')).toBeNull();
  });

  it('never logs the address, the header or a prefix', async () => {
    const { app, lines } = setup(peerIs(CADDY_PEER));
    await whoami(app, '198.51.100.1');
    await whoami(app, '2001:db8:1:2::9');
    const text = JSON.stringify(lines());
    for (const needle of ['198.51.100', '2001:db8', '10.63.2.10']) expect(text).not.toContain(needle);
  });
});

describe('over a real socket, with runApi wiring (conninfo)', () => {
  type Answer = { status: number; body: string };
  let server: Server;
  let trusting: Server;
  let port = 0;
  let trustingPort = 0;

  const send = (p: number, path: string, headers: Record<string, string>): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: p, method: 'GET', path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

  beforeAll(async () => {
    const config = readApiConfig({
      MJK_DOMAIN: 'mjk.test',
      CF_ACCESS_TEAM: 'test-team',
      CF_ACCESS_AUD: 'a'.repeat(64),
    });
    if (typeof config === 'string') throw new Error(config);
    const { logger } = memoryLogger('api');
    const edge = edgeDeps(config, logger);
    const mount = (v1: Parameters<Parameters<typeof buildApp>[1]>[0]) => {
      v1.get('/whoami', (c) => c.json({ client: c.var.client ?? null }));
    };
    const base = { db: {} as Db, logger, ping: async () => true };
    // runApi's own deps: the peer from conninfo, caddy as the trusted peer.
    server = await listen(buildApp({ ...base, ...edge }, mount), 0, '127.0.0.1');
    port = (server.address() as AddressInfo).port;
    // The same conninfo wiring with loopback as the trusted peer: the header path over a socket.
    const clientAddress = edge.clientAddress;
    if (clientAddress === undefined) throw new Error('edgeDeps sets clientAddress');
    trusting = await listen(
      buildApp({ ...base, ...edge, clientAddress: { ...clientAddress, trustedPeer: '127.0.0.1' } }, mount),
      0,
      '127.0.0.1',
    );
    trustingPort = (trusting.address() as AddressInfo).port;
  });
  afterAll(async () => {
    if (server !== undefined) await drain(server, 1_000);
    if (trusting !== undefined) await drain(trusting, 1_000);
  });
  beforeEach(() => {
    msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
  });

  it('a forged X-Mjk-Client, X-Forwarded-For and CF-Connecting-IP from a non-caddy peer: the peer is the client', async () => {
    const a = await send(port, '/api/v1/whoami', {
      Host: 'mjk.test',
      'X-Mjk-Client': '198.51.100.1',
      'X-Forwarded-For': '198.51.100.2',
      'CF-Connecting-IP': '198.51.100.3',
      'True-Client-IP': '198.51.100.4',
    });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ client: { address: '127.0.0.1', prefix: '127.0.0.0/24', prefix48: null } });
  });

  it('from the trusted peer the header counts over a socket too', async () => {
    const a = await send(trustingPort, '/api/v1/whoami', { Host: 'mjk.test', 'X-Mjk-Client': '198.51.100.1' });
    expect(JSON.parse(a.body)).toMatchObject({ client: { address: '198.51.100.1' } });
  });

  it('the admin host needs the Access JWT over a socket; /api/admin/* on the public host is a 404', async () => {
    const admin = await send(port, '/api/v1/whoami', { Host: 'admin.mjk.test' });
    expect(admin.status).toBe(401);
    expect(JSON.parse(admin.body)).toEqual({ error: 'unauthorized' });
    const pub = await send(port, '/api/admin/users', { Host: 'mjk.test' });
    expect(pub.status).toBe(404);
    expect(JSON.parse(pub.body)).toEqual({ error: 'not_found' });
  });
});
