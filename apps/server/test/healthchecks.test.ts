import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createPinger, pingUrl } from '../src/lib/healthchecks.ts';
import { memoryLogger } from '../src/lib/log.ts';

// A 22-character URL-safe placeholder, built at run time so no key-shaped literal is committed.
const KEY = `${'k'.repeat(10)}_-${'k'.repeat(10)}`;
const secrets = (key?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'mjk-hc-'));
  if (key !== undefined) writeFileSync(join(dir, 'hc_ping_key'), `${key}\n`);
  return dir;
};

describe('pingUrl', () => {
  it('builds the success and fail URLs of a check', () => {
    expect(pingUrl(KEY, 'mjk-worker', 'success')).toBe(`https://hc-ping.com/${KEY}/mjk-worker`);
    expect(pingUrl(KEY, 'mjk-worker', 'fail')).toBe(`https://hc-ping.com/${KEY}/mjk-worker/fail`);
  });

  it.each([['a/b'], ['A'], [''], ['x?y'], ['-x'], ['x'.repeat(65)]])('refuses the slug %j', (slug) => {
    expect(pingUrl(KEY, slug, 'success')).toBeUndefined();
  });

  it.each([[''], ['short'], ['has/slash-0123456789'], ['has space-0123456789']])('refuses the key %j', (key) => {
    expect(pingUrl(key, 'mjk-worker', 'success')).toBeUndefined();
  });
});

describe('createPinger', () => {
  it('is disabled without a key file and says so once, with a fixed code', async () => {
    const { logger, lines } = memoryLogger('worker');
    const pinger = createPinger({ logger, secretsDir: secrets() });
    expect(pinger.enabled).toBe(false);
    expect(await pinger.ping('mjk-worker')).toBe(false);
    expect(await pinger.ping('mjk-worker', 'fail')).toBe(false);
    expect(lines().map((l) => l.msg)).toEqual(['healthchecks_disabled']);
  });

  it('is disabled for a key that is not a ping key', () => {
    const { logger, lines } = memoryLogger('worker');
    expect(createPinger({ logger, secretsDir: secrets('has spaces in it') }).enabled).toBe(false);
    expect(lines().map((l) => l.msg)).toEqual(['healthchecks_key_invalid']);
  });

  it('is disabled when the key path is a directory', () => {
    const dir = secrets();
    mkdirSync(join(dir, 'hc_ping_key'));
    expect(createPinger({ logger: memoryLogger().logger, secretsDir: dir }).enabled).toBe(false);
  });

  it('pings success and fail on the key and slug', async () => {
    const seen: string[] = [];
    server.use(
      http.post('https://hc-ping.com/:key/:slug', ({ params }) => {
        seen.push(`${params.key}/${params.slug}`);
        return new HttpResponse('OK');
      }),
      http.post('https://hc-ping.com/:key/:slug/fail', ({ params }) => {
        seen.push(`${params.key}/${params.slug}/fail`);
        return new HttpResponse('OK');
      }),
    );
    const { logger, lines } = memoryLogger('worker');
    const pinger = createPinger({ logger, secretsDir: secrets(KEY) });
    expect(pinger.enabled).toBe(true);
    expect(await pinger.ping('mjk-worker')).toBe(true);
    expect(await pinger.ping('mjk-worker', 'fail')).toBe(true);
    expect(seen).toEqual([`${KEY}/mjk-worker`, `${KEY}/mjk-worker/fail`]);
    expect(lines()).toEqual([]);
  });

  it('answers false on a 4xx, a 5xx, a network error and a timeout, and never logs the URL or the key', async () => {
    const { logger, lines } = memoryLogger('worker');
    const pinger = createPinger({ logger, secretsDir: secrets(KEY), timeoutMs: 50 });
    server.use(http.post('https://hc-ping.com/:key/:slug', () => new HttpResponse('not found', { status: 404 })));
    expect(await pinger.ping('mjk-worker')).toBe(false);
    server.use(http.post('https://hc-ping.com/:key/:slug', () => new HttpResponse(null, { status: 502 })));
    expect(await pinger.ping('mjk-worker')).toBe(false);
    server.use(http.post('https://hc-ping.com/:key/:slug', () => HttpResponse.error()));
    expect(await pinger.ping('mjk-worker')).toBe(false);
    server.use(
      http.post('https://hc-ping.com/:key/:slug', async () => {
        await delay(2_000);
        return new HttpResponse('OK');
      }),
    );
    expect(await pinger.ping('mjk-worker')).toBe(false);
    expect(lines().map((l) => l.msg)).toEqual(Array(4).fill('healthchecks_ping_failed'));
    const text = JSON.stringify(lines());
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('hc-ping');
  });

  it('does not follow a redirect (the key would travel to another host)', async () => {
    let followed = false;
    server.use(
      http.post(
        'https://hc-ping.com/:key/:slug',
        () => new HttpResponse(null, { status: 302, headers: { Location: 'https://evil.invalid/x' } }),
      ),
      http.all('https://evil.invalid/*', () => {
        followed = true;
        return new HttpResponse('OK');
      }),
    );
    const pinger = createPinger({ logger: memoryLogger().logger, secretsDir: secrets(KEY) });
    expect(await pinger.ping('mjk-worker')).toBe(false);
    expect(followed).toBe(false);
  });

  it('refuses a bad slug without a request', async () => {
    const { logger, lines } = memoryLogger('worker');
    const pinger = createPinger({ logger, secretsDir: secrets(KEY) });
    expect(await pinger.ping('Bad Slug')).toBe(false);
    expect(lines().map((l) => l.msg)).toEqual(['healthchecks_slug_invalid']);
  });
});
