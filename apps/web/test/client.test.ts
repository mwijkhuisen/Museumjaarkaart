import { readFileSync } from 'node:fs';
import { Me, MuseumList } from '@mjk/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/zod.ts';
import { z } from 'zod';
import { ApiError, ApiFailure, getJson, sendJson } from '../src/lib/api.ts';
import { formatDate, formatDateTime, formatMonth } from '../src/lib/format.ts';

describe('the entries (CLAUDE.md gotcha: module order)', () => {
  it.each([
    ['entry-client.tsx', './lib/zod.ts', './styles.css'],
    ['entry-server.tsx', './lib/zod.ts', './styles.css'],
    ['admin/main.tsx', '../lib/zod.ts', '../styles.css'],
  ])('%s imports lib/zod.ts, then the stylesheet, first', (entry, zod, css) => {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports.slice(0, 2)).toEqual([`import '${zod}';`, `import '${css}';`]);
  });

  it('lib/zod.ts makes Zod jitless', () => {
    expect(z.config().jitless).toBe(true);
  });
});

describe('getJson', () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('parses the answer with its contract', async () => {
    const list = { items: [], next_cursor: null, total: 0 };
    await expect(getJson('/api/v1/museums', MuseumList, answer(200, list))).resolves.toEqual(list);
  });

  it('refuses an answer that breaks the contract', async () => {
    await expect(getJson('/api/v1/museums', MuseumList, answer(200, { items: 'no' }))).rejects.toThrow(z.ZodError);
  });

  it('turns a non-2xx answer into ApiFailure with its status', async () => {
    await expect(getJson('/api/v1/museums/x', MuseumList, answer(404, { error: 'not_found' }))).rejects.toEqual(
      new ApiFailure(404),
    );
  });
});

describe('sendJson', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (res: Response) => {
    const fetcher = vi.fn(async () => res);
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('sends JSON only with a body, and never a CSRF header', async () => {
    const fetcher = stub(json(202, { accepted: true }));
    await sendJson('POST', '/api/v1/auth/code', { a: 1 });
    await sendJson('POST', '/api/v1/auth/signout');
    const [withBody, without] = fetcher.mock.calls.map((c) => c as unknown as [string, RequestInit]);
    expect(withBody?.[1]).toEqual({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(without?.[1]).toEqual({ method: 'POST', headers: { accept: 'application/json' } });
  });

  it('parses a 2xx answer with its schema', async () => {
    stub(json(200, { user: null }));
    await expect(sendJson('PATCH', '/api/v1/me', { display_name: 'x' }, Me)).resolves.toEqual({ user: null });
    stub(json(200, { nope: 1 }));
    await expect(sendJson('PATCH', '/api/v1/me', { display_name: 'x' }, Me)).rejects.toThrow(z.ZodError);
  });

  it('turns a non-2xx answer into ApiError with status, code, fields and Retry-After', async () => {
    stub(json(429, { error: 'rate_limited' }, { 'retry-after': '120' }));
    await expect(sendJson('POST', '/api/v1/auth/password', {})).rejects.toEqual(
      new ApiError(429, 'rate_limited', [], 120),
    );
    stub(json(422, { error: 'invalid', fields: ['handle', 'age_confirmed'] }));
    await expect(sendJson('POST', '/api/v1/auth/signup', {})).rejects.toEqual(
      new ApiError(422, 'invalid', ['handle', 'age_confirmed'], null),
    );
    stub(new Response('<html>', { status: 502 }));
    await expect(sendJson('POST', '/api/v1/auth/signup', {})).rejects.toEqual(new ApiError(502, 'unknown', [], null));
  });
});

describe('dates (Europe/Amsterdam, long months)', () => {
  it.each<[string, 'nl' | 'en', string, string]>([
    ['2026-11-01', 'nl', '1 november 2026', 'november 2026'],
    ['2026-11-01', 'en', '1 November 2026', 'November 2026'],
    ['2026-03-29', 'nl', '29 maart 2026', 'maart 2026'],
    ['2026-12-31', 'nl', '31 december 2026', 'december 2026'],
  ])('%s in %s', (iso, locale, date, month) => {
    expect(formatDate(iso, locale)).toBe(date);
    expect(formatMonth(iso, locale)).toBe(month);
  });

  // A datetime's first ten characters are its UTC day, not always the Amsterdam day: refused.
  it.each(['2026-12-31T23:30:00Z', '2026-12-31 ', '31-12-2026', ''])('refuses %j', (iso) => {
    expect(() => formatDate(iso, 'nl')).toThrow(RangeError);
    expect(() => formatMonth(iso, 'nl')).toThrow(RangeError);
  });
});

describe('formatDateTime (an instant, in Europe/Amsterdam)', () => {
  it('shows the Amsterdam wall clock, in summer and winter time', () => {
    expect(formatDateTime('2026-07-01T10:05:00Z', 'nl')).toContain('12:05');
    expect(formatDateTime('2026-12-01T10:05:00Z', 'en')).toContain('11:05');
    expect(formatDateTime('2026-12-31T23:30:00Z', 'nl')).toContain('1 januari 2027');
  });
});
