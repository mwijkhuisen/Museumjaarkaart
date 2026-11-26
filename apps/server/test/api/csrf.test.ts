import { ErrorBody } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiDeps, buildApp } from '../../src/api/app.ts';
import { readJson } from '../../src/api/body.ts';
import { isJsonType } from '../../src/api/middleware/csrf.ts';
import type { Db } from '../../src/db/kysely.ts';
import { memoryLogger } from '../../src/lib/log.ts';

// Criterion 6 (A§9, A§14): every unsafe method needs the browser's same-origin proof (403
// otherwise), mutations take JSON only (415), and the body reader counts what it reads. The
// real-socket twin is in socket.int.test.ts.

const SITE = { domain: 'mjk.test', adminHost: 'admin.mjk.test' };
const Body = z.strictObject({ a: z.number() });

function setup(site: ApiDeps['site'] | null = SITE) {
  const { logger, lines } = memoryLogger('api');
  const app = buildApp({ db: {} as Db, logger, ping: async () => true, ...(site ? { site } : {}) }, (v1) => {
    v1.post('/echo', async (c) => c.json(await readJson(c, Body)));
    v1.post('/bodyless', (c) => c.body(null, 204));
    v1.get('/read', (c) => c.json({ ok: true }));
  });
  return { app, lines };
}

// app.request() sends no Content-Length of its own (a real client does; socket.int.test.ts), so a string
// body gets its byte length here.
const call = (app: ReturnType<typeof setup>['app'], init: RequestInit & { path?: string; host?: string }) =>
  app.request(`http://localhost${init.path ?? '/api/v1/echo'}`, {
    method: 'POST',
    ...init,
    headers: {
      host: init.host ?? 'mjk.test',
      ...(typeof init.body === 'string' ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

const JSON_TYPE = { 'Content-Type': 'application/json' };

describe('CSRF on every unsafe method', () => {
  it('passes Sec-Fetch-Site: same-origin, or, without it, the host’s own Origin', async () => {
    const { app } = setup();
    const ok1 = await call(app, { headers: { 'Sec-Fetch-Site': 'same-origin', ...JSON_TYPE }, body: '{"a":1}' });
    expect(ok1.status).toBe(200);
    const ok2 = await call(app, { headers: { Origin: 'https://mjk.test', ...JSON_TYPE }, body: '{"a":1}' });
    expect(ok2.status).toBe(200);
    const ok3 = await call(app, {
      host: 'admin.mjk.test',
      headers: { Origin: 'https://admin.mjk.test', ...JSON_TYPE },
      body: '{"a":1}',
    });
    expect(ok3.status).toBe(200);
  });

  it.each([
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['the other host’s Origin', { Origin: 'https://admin.mjk.test' }],
    ['an http Origin', { Origin: 'http://mjk.test' }],
    ['Origin null', { Origin: 'null' }],
    ['cross-site', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://mjk.test' }],
    ['same-site', { 'Sec-Fetch-Site': 'same-site', Origin: 'https://mjk.test' }],
    ['none', { 'Sec-Fetch-Site': 'none' }],
    ['neither header', {}],
  ])('refuses %s with 403 forbidden, private, no-store', async (_name, headers) => {
    const { app } = setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(app, { method, headers: { ...headers, ...JSON_TYPE }, body: '{"a":1}' });
      expect(r.status, method).toBe(403);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(ErrorBody.parse(await r.json())).toEqual({ error: 'forbidden' });
    }
  });

  it('on the admin host only the admin origin passes', async () => {
    const { app } = setup();
    const r = await call(app, {
      host: 'admin.mjk.test',
      headers: { Origin: 'https://mjk.test', ...JSON_TYPE },
      body: '{"a":1}',
    });
    expect(r.status).toBe(403);
  });

  it('without a site (the ssr’s in-process app) every unsafe method is a 403; GET still answers', async () => {
    const { app } = setup(null);
    const r = await call(app, { headers: { 'Sec-Fetch-Site': 'same-origin', ...JSON_TYPE }, body: '{"a":1}' });
    expect(r.status).toBe(403);
    expect((await app.request('http://localhost/api/v1/read')).status).toBe(200);
  });

  it('never applies to GET, HEAD or OPTIONS', async () => {
    const { app } = setup();
    const r = await app.request('http://localhost/api/v1/read', { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(200);
  });
});

describe('JSON-only mutations', () => {
  const SAME = { 'Sec-Fetch-Site': 'same-origin' };

  it('refuses a form body, text/plain and a body without a type with 415', async () => {
    const { app } = setup();
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      'application/jsonp',
    ]) {
      const r = await call(app, { headers: { ...SAME, 'Content-Type': type }, body: 'a=1' });
      expect(r.status, type).toBe(415);
      expect(ErrorBody.parse(await r.json())).toEqual({ error: 'unsupported_type' });
    }
    const untyped = await call(app, { headers: { ...SAME, 'Content-Length': '3' }, body: 'a=1' });
    expect(untyped.status).toBe(415);
  });

  it('accepts application/json with parameters, in any case', () => {
    expect(isJsonType('application/json')).toBe(true);
    expect(isJsonType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonType('Application/JSON;charset=UTF-8')).toBe(true);
    expect(isJsonType('application/json-patch+json')).toBe(false);
    expect(isJsonType('text/json')).toBe(false);
  });

  it('a body-less POST needs neither a type nor a length', async () => {
    const { app } = setup();
    const r = await call(app, { path: '/api/v1/bodyless', headers: SAME });
    expect(r.status).toBe(204);
  });
});

describe('the body reader', () => {
  const SAME = { 'Sec-Fetch-Site': 'same-origin', ...JSON_TYPE };

  it('parses strictly: an unknown key, a wrong type or no body → 400 with the schema paths only', async () => {
    const { app } = setup();
    const extra = await call(app, { headers: SAME, body: '{"a":1,"zzsecret":2}' });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(await extra.json())).not.toContain('zzsecret');
    const wrong = await call(app, { headers: SAME, body: '{"a":"x"}' });
    expect(await wrong.json()).toEqual({ error: 'bad_request', fields: ['a'] });
    const none = await call(app, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(none.status).toBe(400);
  });

  it('invalid JSON or invalid UTF-8 → 400 with no fields', async () => {
    const { app } = setup();
    for (const body of ['{"a":', '\u{1F600}'.slice(0, 1), 'null x']) {
      const r = await call(app, { headers: SAME, body });
      expect(r.status).toBe(400);
    }
  });

  it('logs how the body was framed as a fixed code, never the content', async () => {
    const { app, lines } = setup();
    await call(app, { headers: SAME, body: '{"a":12345}' });
    await call(app, { path: '/api/v1/bodyless', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    const log = lines().filter((l) => l.msg === 'request');
    expect(log.map((l) => l.body)).toEqual(['length', 'none']);
    expect(JSON.stringify(log)).not.toContain('12345');
  });
});
