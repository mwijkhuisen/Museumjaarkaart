// CI only: the Caddy cases (p1e criteria 3 and 4, A§9, A§15.6, A§17.2) against the real deploy/web/Caddyfile.
// deploy/e2e/stack.sh runs it as the `probe` service, a peer at 10.63.2.20 on the e2e copy of mjk-edge and
// 10.63.6.20 on the copy of mjk-tunnel-edge, where the TLS `edge` stands in for cloudflared at 10.63.6.10.
//   node deploy/e2e/caddy-cases.mjs real   the real api and ssr: noindex and the headers on their answers
//   node deploy/e2e/caddy-cases.mjs echo   api and ssr replaced by deploy/e2e/echo.mjs (caddy-cases.yaml)
//   node deploy/e2e/caddy-cases.mjs down   the same with both echo upstreams stopped: the 502s
// Exit 0 when every case passes, 1 otherwise. Plain node:http(s), so the Host header is ours to set.
import { readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const DOMAIN = 'mjk.test';
const ADMIN = `admin.${DOMAIN}`;
const CADDY_EDGE = '10.63.2.10'; // caddy on the copy of mjk-edge (the api trusts X-Mjk-Client from it)
const CADDY_TUNNEL = '10.63.6.11'; // caddy on the copy of mjk-tunnel-edge (dynamic in production)
const EDGE = '10.63.6.10'; // the cloudflared stand-in: the only address Caddy trusts
const PROBE_EDGE = '10.63.2.20';
const PROBE_TUNNEL = '10.63.6.20';
// stack.sh greps Caddy's log for it (keep the two in step): the error log carries no URI or query.
const MARKER = 'mjk-probe-marker-7f3a';
const FORGED = {
  'x-forwarded-for': '203.0.113.7',
  'cf-connecting-ip': '203.0.113.8',
  'true-client-ip': '203.0.113.9',
  'x-mjk-client': '203.0.113.10',
};
const CLIENT_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'true-client-ip'];

const PUBLIC_CSP = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://media.${DOMAIN}; media-src https://media.${DOMAIN}; connect-src 'self' https://media.${DOMAIN}; worker-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const ADMIN_CSP = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://media.${DOMAIN}; connect-src 'self'; worker-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const COMMON = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const PUBLIC = {
  ...COMMON,
  'content-security-policy': PUBLIC_CSP,
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-robots-tag': 'noindex',
};
const ADMIN_HEADERS = {
  ...COMMON,
  'content-security-policy': ADMIN_CSP,
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};

/**
 * One request. `via`: 'edge' (https through the stand-in), 'edge-http' (its plain-http site), or an
 * address of caddy (a direct, untrusted peer). Resolves with status, headers, body and the time taken.
 */
function send(via, path, opts = {}, tries = 3) {
  const { host = DOMAIN, method = 'GET', headers = {}, body } = opts;
  const tls = via === 'edge';
  const options = {
    host: via === 'edge' || via === 'edge-http' ? EDGE : via,
    port: tls ? 443 : 80,
    method,
    path,
    headers: { host, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
    agent: false,
    ...(tls ? { servername: host, rejectUnauthorized: false } : {}),
  };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = (tls ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        answered = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          ms: Date.now() - started,
        });
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      // The whole answer was read: a reset after it (Caddy closing on a body it refused) changes nothing.
      if (answered) return;
      // A body over a cap: Caddy answers 413 and closes while this client may still be writing, and the reset can
      // beat the answer (seen once in P3b, on the 2 MiB + 1 import case). Only a write-side reset of a request with
      // a body is sent again; the case still has to see its 413 and headers.
      if (body && tries > 1 && /^write (ECONNRESET|EPIPE)$/.test(err.message))
        resolve(send(via, path, opts, tries - 1));
      else reject(err);
    });
    req.end(body);
  });
}

/** The echo upstream's report, or null when the answer did not come from deploy/e2e/echo.mjs. */
function echoOf(res) {
  try {
    const j = JSON.parse(res.body);
    return typeof j.echo === 'string' ? j : null;
  } catch {
    return null;
  }
}

const failures = [];
let passed = 0;

async function check(name, fn) {
  const problems = [];
  const expect = (ok, what) => {
    if (!ok) problems.push(what);
  };
  try {
    await fn(expect);
  } catch (err) {
    problems.push(`threw ${err instanceof Error ? err.message : String(err)}`);
  }
  if (problems.length > 0) {
    failures.push(name);
    console.log(`FAIL ${name}\n  - ${problems.join('\n  - ')}`);
  } else {
    passed += 1;
    console.log(`ok   ${name}`);
  }
}

function headersAre(expect, res, wanted, label) {
  for (const [k, v] of Object.entries(wanted))
    expect(res.headers[k] === v, `${label}: ${k} is ${JSON.stringify(res.headers[k])}, expected ${JSON.stringify(v)}`);
  expect(res.headers.server === undefined, `${label}: a Server header`);
  expect(res.headers['set-cookie'] === undefined, `${label}: a Set-Cookie header`);
}

const statusIs = (expect, res, status, label) =>
  expect(res.status === status, `${label}: status ${res.status}, expected ${status}`);

/** Checks the echo reached `name` and none of `absent` arrived there. */
function reached(expect, res, name, absent = []) {
  const e = echoOf(res);
  expect(e?.echo === name, `answered by ${e?.echo ?? 'no echo'}, expected ${name}`);
  for (const h of absent) expect(e?.headers?.[h] === undefined, `${h} reached ${name}: ${e?.headers?.[h]}`);
  return e;
}

function anAsset() {
  const dir = '/app/apps/web/dist/client/assets';
  const file = readdirSync(dir).find((f) => f.endsWith('.js'));
  if (!file) throw new Error(`no .js file in ${dir}`);
  return `/assets/${file}`;
}

async function realCases() {
  const asset = anAsset();
  await check('real: a page carries the public headers and noindex', async (expect) => {
    const res = await send('edge', '/');
    statusIs(expect, res, 200, '/');
    headersAre(expect, res, PUBLIC, '/');
  });
  await check('real: an asset carries noindex', async (expect) => {
    const res = await send('edge', asset);
    statusIs(expect, res, 200, asset);
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'public, max-age=31536000, immutable' }, asset);
  });
  await check("real: /api/v1/healthz carries noindex and keeps the api's Cache-Control", async (expect) => {
    const res = await send('edge', '/api/v1/healthz');
    statusIs(expect, res, 200, 'healthz');
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, 'healthz');
  });
  await check("real: ssr's 404 page carries noindex", async (expect) => {
    const res = await send('edge', '/no-such-page-at-all');
    statusIs(expect, res, 404, '404 page');
    headersAre(expect, res, PUBLIC, '404 page');
  });
  await check("real: Caddy's 404 for a missing asset carries noindex and no-store", async (expect) => {
    const res = await send('edge', '/assets/nope.js');
    statusIs(expect, res, 404, 'missing asset');
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, 'missing asset');
  });
}

async function echoCases() {
  const asset = anAsset();

  // Client address (A§9): only the edge's X-Forwarded-For counts, its right-most untrusted entry.
  await check('the edge names the client: X-Mjk-Client is the address the edge saw', async (expect) => {
    const res = await send('edge', '/api/v1/x');
    statusIs(expect, res, 200, 'api');
    const e = reached(expect, res, 'api', [...CLIENT_HEADERS, 'cf-access-jwt-assertion']);
    expect(e?.headers?.['x-mjk-client'] === PROBE_TUNNEL, `x-mjk-client ${e?.headers?.['x-mjk-client']}`);
    expect(e?.peer === CADDY_EDGE, `the api's peer is ${e?.peer}, expected caddy's ${CADDY_EDGE}`);
    expect(e?.headers?.host === DOMAIN, `host ${e?.headers?.host}`);
  });
  await check('forged address headers in front of the edge: strict takes the right-most', async (expect) => {
    const res = await send('edge', '/api/v1/x', { headers: FORGED });
    const e = reached(expect, res, 'api', CLIENT_HEADERS);
    expect(e?.headers?.['x-mjk-client'] === PROBE_TUNNEL, `x-mjk-client ${e?.headers?.['x-mjk-client']}`);
  });
  for (const [target, peer, label] of [
    [CADDY_EDGE, PROBE_EDGE, 'a peer on mjk-edge (like ssr)'],
    [CADDY_TUNNEL, PROBE_TUNNEL, "a peer inside the edge's /24 but not its /32"],
  ]) {
    await check(`forged address headers from ${label} arrive as the peer's address`, async (expect) => {
      const res = await send(target, '/api/v1/x', { headers: FORGED });
      const e = reached(expect, res, 'api', CLIENT_HEADERS);
      expect(e?.headers?.['x-mjk-client'] === peer, `x-mjk-client ${e?.headers?.['x-mjk-client']}, expected ${peer}`);
    });
  }
  await check('the api gets the Cookie (sessions from P2a) but no Access JWT on the public host', async (expect) => {
    const res = await send('edge', '/api/v1/x', { headers: { cookie: 'a=b', 'cf-access-jwt-assertion': 'tok' } });
    const e = reached(expect, res, 'api', ['cf-access-jwt-assertion']);
    expect(e?.headers?.cookie === 'a=b', `cookie ${e?.headers?.cookie}`);
  });

  // ssr never sees a session or the client (invariant 8).
  for (const via of ['edge', CADDY_EDGE]) {
    await check(`ssr gets no Cookie, Authorization, Access JWT or client address (via ${via})`, async (expect) => {
      const res = await send(via, '/museum/x', {
        headers: {
          ...FORGED,
          cookie: '__Host-mjk_sid=secret',
          authorization: 'Bearer secret',
          'cf-access-jwt-assertion': 'tok',
        },
      });
      statusIs(expect, res, 200, 'ssr');
      reached(expect, res, 'ssr', [...Object.keys(FORGED), 'cookie', 'authorization', 'cf-access-jwt-assertion']);
      headersAre(expect, res, PUBLIC, 'ssr');
    });
  }

  // 308 to https, before any route.
  for (const [via, host, wanted, label] of [
    [CADDY_EDGE, DOMAIN, PUBLIC, 'public, direct'],
    ['edge-http', DOMAIN, PUBLIC, "public, through the edge's http site"],
    [CADDY_EDGE, ADMIN, ADMIN_HEADERS, 'admin, direct'],
    ['edge-http', ADMIN, ADMIN_HEADERS, "admin, through the edge's http site"],
  ]) {
    await check(`X-Forwarded-Proto http is a no-store 308 to https (${label})`, async (expect) => {
      const path = '/museum/a?b=1&c=%2F';
      const res = await send(via, path, { host, headers: { 'x-forwarded-proto': 'http' } });
      statusIs(expect, res, 308, '308');
      expect(res.headers.location === `https://${host}${path}`, `location ${res.headers.location}`);
      expect(/\bno-store\b/.test(res.headers['cache-control'] ?? ''), `cache-control ${res.headers['cache-control']}`);
      headersAre(expect, res, wanted, '308');
      expect(echoOf(res) === null, 'the 308 reached an upstream');
    });
  }
  await check('X-Forwarded-Proto https is not redirected', async (expect) => {
    const res = await send(CADDY_EDGE, '/', { headers: { 'x-forwarded-proto': 'https' } });
    statusIs(expect, res, 200, 'https');
    reached(expect, res, 'ssr');
  });

  // 421 for any other Host (Waterheight ADR-0021 §4).
  for (const host of ['evil.test', CADDY_EDGE, `${DOMAIN}.evil.test`, `media.${DOMAIN}`, `x.${ADMIN}`]) {
    await check(`Host ${host} is a no-store 421`, async (expect) => {
      const res = await send(CADDY_EDGE, `/api/v1/x?${MARKER}`, { host, headers: { 'x-forwarded-proto': 'http' } });
      statusIs(expect, res, 421, host);
      headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, host);
      expect(echoOf(res) === null, 'the 421 reached an upstream');
    });
  }

  // Invariant 3: no admin route on the public host.
  for (const [method, path] of [
    ['GET', '/api/admin'],
    ['GET', '/api/admin/'],
    ['GET', '/api/admin/x?y=1'],
    ['POST', '/api/admin/x'],
    ['DELETE', '/api/admin/x'],
  ]) {
    await check(`${method} ${path} on the public host is a no-store 404 that reaches no upstream`, async (expect) => {
      const res = await send('edge', path, { method, headers: { 'cf-access-jwt-assertion': 'tok' } });
      statusIs(expect, res, 404, path);
      headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, path);
      expect(echoOf(res) === null, 'reached an upstream');
    });
  }

  // noindex (prelaunch profile) on every kind of answer, and no-store on the errors.
  await check('noindex on a page', async (expect) => {
    const res = await send('edge', '/');
    statusIs(expect, res, 200, '/');
    headersAre(expect, res, PUBLIC, '/');
  });
  await check('noindex on an asset', async (expect) => {
    const res = await send('edge', asset);
    statusIs(expect, res, 200, asset);
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'public, max-age=31536000, immutable' }, asset);
  });
  await check("noindex on /api/v1/healthz, the api's Cache-Control kept", async (expect) => {
    const res = await send('edge', '/api/v1/healthz');
    reached(expect, res, 'api');
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'private, no-store' }, 'healthz');
  });
  await check("noindex on an upstream's 404", async (expect) => {
    const res = await send('edge', '/nope?status=404');
    statusIs(expect, res, 404, 'upstream 404');
    reached(expect, res, 'ssr');
    headersAre(expect, res, PUBLIC, 'upstream 404');
  });
  await check("noindex and no-store on Caddy's 404 for a missing asset", async (expect) => {
    const res = await send('edge', '/assets/nope.js');
    statusIs(expect, res, 404, 'missing asset');
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, 'missing asset');
  });
  // P1d: the map's glyphs and sprites, files under /srv/web/map only.
  const glyph = '/map/028c18f/fonts/Noto%20Sans%20Regular/0-255.pbf';
  await check('a map file is immutable with the public headers', async (expect) => {
    const res = await send('edge', glyph);
    statusIs(expect, res, 200, glyph);
    headersAre(expect, res, { ...PUBLIC, 'cache-control': 'public, max-age=31536000, immutable' }, glyph);
  });
  for (const path of ['/map/028c18f/nope.pbf', '/map/028c18f/fonts/', '/map/028c18f/fonts']) {
    await check(`${path} is Caddy's no-store 404`, async (expect) => {
      const res = await send('edge', path);
      statusIs(expect, res, 404, path);
      headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, path);
    });
  }
  for (const path of ['/api/v1/x', '/']) {
    await check(`a body over 64 KiB to ${path} is a no-store 413 with noindex`, async (expect) => {
      const res = await send('edge', path, { method: 'POST', body: Buffer.alloc(64 * 1024 + 1, 'a') });
      statusIs(expect, res, 413, '413');
      headersAre(expect, res, { ...PUBLIC, 'cache-control': 'no-store' }, '413');
    });
  }
  // P2c design 4: an import's file and its confirm take 2 MiB, and only those two POSTs.
  for (const path of ['/api/v1/me/imports', '/api/v1/me/imports/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/confirm']) {
    await check(`POST ${path}: over 64 KiB reaches the api, over 2 MiB is a no-store 413`, async (expect) => {
      const ok = await send('edge', path, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024, 'a') });
      statusIs(expect, ok, 200, '2 MiB');
      reached(expect, ok, 'api');
      const big = await send('edge', path, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024 + 1, 'a') });
      statusIs(expect, big, 413, '413');
      headersAre(expect, big, { ...PUBLIC, 'cache-control': 'no-store' }, '413');
    });
  }
  for (const [method, path] of [
    ['PUT', '/api/v1/me/imports'],
    ['POST', '/api/v1/me/imports/x'],
    ['POST', '/api/v1/me/imports/x/confirm/y'],
    ['POST', '/api/v1/me/importsx'],
  ]) {
    await check(`${method} ${path}: a body over 64 KiB is a 413`, async (expect) => {
      const res = await send('edge', path, { method, body: Buffer.alloc(64 * 1024 + 1, 'a') });
      statusIs(expect, res, 413, '413');
    });
  }

  // P3b: an upload chunk takes 8 MiB, and only `PUT /api/v1/uploads/<uuid>/chunks/<n>`.
  const chunk = '/api/v1/uploads/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/chunks/0';
  await check(`PUT ${chunk}: 8 MiB reaches the api, over 8 MiB is a no-store 413`, async (expect) => {
    const ok = await send('edge', chunk, { method: 'PUT', body: Buffer.alloc(8 * 1024 * 1024, 'a') });
    statusIs(expect, ok, 200, '8 MiB');
    reached(expect, ok, 'api');
    const big = await send('edge', chunk, { method: 'PUT', body: Buffer.alloc(8 * 1024 * 1024 + 1, 'a') });
    statusIs(expect, big, 413, '413');
    headersAre(expect, big, { ...PUBLIC, 'cache-control': 'no-store' }, '413');
  });
  for (const [method, path] of [
    ['POST', chunk],
    ['PUT', '/api/v1/uploads/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/chunks/100'],
    ['PUT', '/api/v1/uploads/x/chunks/0'],
    ['PUT', '/api/v1/uploads/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/chunks/0/x'],
  ]) {
    await check(`${method} ${path}: a body over 64 KiB is a 413`, async (expect) => {
      const res = await send('edge', path, { method, body: Buffer.alloc(64 * 1024 + 1, 'a') });
      statusIs(expect, res, 413, '413');
    });
  }
  // P3b: a pending photo's preview gets the media host's sandbox CSP instead of the page CSP (A§12, A§14);
  // every other api path keeps the page CSP. Through the real Caddy, so the deferred header order is proven.
  const preview = '/api/v1/uploads/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/preview';
  await check(`${preview} has default-src 'none'; sandbox`, async (expect) => {
    const res = await send('edge', `${preview}?w=400`);
    reached(expect, res, 'api');
    headersAre(expect, res, { ...PUBLIC, 'content-security-policy': "default-src 'none'; sandbox" }, preview);
  });
  for (const path of [`${preview}/x`, '/api/v1/uploads/x/preview', '/api/v1/uploads']) {
    await check(`${path} keeps the page CSP`, async (expect) => {
      const res = await send('edge', path);
      reached(expect, res, 'api');
      headersAre(expect, res, PUBLIC, path);
    });
  }

  // The admin host (A§5, A§15.6, ADR-0004): the SPA's one page for every path that is not an asset or an api route.
  for (const via of ['edge', CADDY_EDGE]) {
    await check(`admin: the SPA page with the admin headers (via ${via})`, async (expect) => {
      for (const path of ['/', '/moderation/queue', '/x']) {
        const res = await send(via, path, { host: ADMIN });
        statusIs(expect, res, 200, path);
        expect(
          (res.headers['content-type'] ?? '').startsWith('text/html'),
          `content-type ${res.headers['content-type']}`,
        );
        expect(res.body.includes('<div id="admin"></div>'), `${path}: not the admin SPA page`);
        headersAre(expect, res, ADMIN_HEADERS, path);
      }
    });
  }
  await check('admin: an asset is a file with the admin headers', async (expect) => {
    const res = await send('edge', asset, { host: ADMIN });
    statusIs(expect, res, 200, asset);
    headersAre(expect, res, ADMIN_HEADERS, asset);
  });
  await check('admin: a missing asset is a 404 with the admin headers', async (expect) => {
    const res = await send('edge', '/assets/nope.js', { host: ADMIN });
    statusIs(expect, res, 404, 'missing asset');
    headersAre(expect, res, ADMIN_HEADERS, 'missing asset');
  });
  await check('admin: /map/* is not served (the SPA page, never the file)', async (expect) => {
    const res = await send('edge', glyph, { host: ADMIN });
    statusIs(expect, res, 200, glyph);
    expect(res.body.includes('<div id="admin"></div>'), 'not the admin SPA page');
    headersAre(expect, res, ADMIN_HEADERS, glyph);
  });
  // Signup is a public-host route, uploads and the other api paths are not the admin SPA's, and /api/v1/meow
  // is not /api/v1/me.
  for (const path of [
    '/api',
    '/api/',
    '/api/v1',
    '/api/v1/healthz',
    '/api/x',
    '/api/v1/auth/signup',
    '/api/v1/auth/signup/x',
    '/api/v1/uploads',
    '/api/v1/meow',
  ]) {
    await check(`admin: ${path} is a 404 that reaches no upstream`, async (expect) => {
      const res = await send('edge', path, { host: ADMIN });
      statusIs(expect, res, 404, path);
      headersAre(expect, res, ADMIN_HEADERS, path);
      expect(echoOf(res) === null, 'reached an upstream');
    });
  }
  // Only GET and HEAD reach the api on the museums routes.
  for (const method of ['POST', 'PUT', 'DELETE']) {
    await check(`admin: ${method} /api/v1/museums is a 404 that reaches no upstream`, async (expect) => {
      const res = await send('edge', '/api/v1/museums', { host: ADMIN, method });
      statusIs(expect, res, 404, method);
      headersAre(expect, res, ADMIN_HEADERS, method);
      expect(echoOf(res) === null, 'reached an upstream');
    });
  }
  for (const path of [
    '/api/admin',
    '/api/admin/x?y=1',
    '/api/v1/auth/code',
    '/api/v1/me',
    '/api/v1/me/x',
    '/api/v1/museums',
  ]) {
    await check(`admin: ${path} goes to the api with the Access JWT and the client address`, async (expect) => {
      const res = await send('edge', path, {
        host: ADMIN,
        headers: { ...FORGED, 'cf-access-jwt-assertion': 'tok', cookie: 'a=b' },
      });
      statusIs(expect, res, 200, path);
      const e = reached(expect, res, 'api', CLIENT_HEADERS);
      expect(e?.headers?.['cf-access-jwt-assertion'] === 'tok', 'the Access JWT did not reach the api');
      expect(e?.headers?.host === ADMIN, `host ${e?.headers?.host}`);
      expect(e?.headers?.['x-mjk-client'] === PROBE_TUNNEL, `x-mjk-client ${e?.headers?.['x-mjk-client']}`);
      expect(e?.url === path, `url ${e?.url}`);
      headersAre(expect, res, ADMIN_HEADERS, path);
    });
  }
  await check('admin: a body over 64 KiB is a 413 with the admin headers', async (expect) => {
    const res = await send('edge', '/api/admin/x', { host: ADMIN, method: 'POST', body: Buffer.alloc(64 * 1024 + 1) });
    statusIs(expect, res, 413, '413');
    headersAre(expect, res, ADMIN_HEADERS, '413');
  });

  // The health site listens on caddy's loopback only.
  await check('the health site is not reachable from another container', async (expect) => {
    const health = await new Promise((resolve) => {
      const req = http.get({ host: CADDY_EDGE, port: 8089, path: '/healthz', agent: false }, () => resolve('answered'));
      req.setTimeout(5_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
      req.on('error', (err) => resolve(err.code));
    });
    expect(health === 'ECONNREFUSED', `port 8089 from another container: ${health}`);
  });
}

async function downCases() {
  for (const [path, host, wanted] of [
    [`/?${MARKER}`, DOMAIN, { ...PUBLIC, 'cache-control': 'no-store' }],
    [`/api/v1/healthz?${MARKER}`, DOMAIN, { ...PUBLIC, 'cache-control': 'no-store' }],
    [`/api/admin/x?${MARKER}`, ADMIN, ADMIN_HEADERS],
  ]) {
    await check(
      `${host}${path.split('?')[0]} with its upstream down is a 502 after lb_try_duration`,
      async (expect) => {
        const res = await send('edge', path, { host });
        statusIs(expect, res, 502, '502');
        headersAre(expect, res, wanted, '502');
        expect(res.ms >= 4_500, `answered after ${res.ms} ms, before the 5 s lb_try_duration`);
      },
    );
  }
}

const mode = process.argv[2];
const cases = { real: realCases, echo: echoCases, down: downCases }[mode];
if (!cases) {
  console.error('usage: caddy-cases.mjs real|echo|down');
  process.exit(64);
}
await cases();
console.log(`caddy cases (${mode}): ${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
