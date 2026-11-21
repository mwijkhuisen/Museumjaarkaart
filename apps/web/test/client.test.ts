import { readFileSync } from 'node:fs';
import { MuseumList } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import '../src/lib/zod.ts';
import { z } from 'zod';
import { ApiFailure, getJson } from '../src/lib/api.ts';
import { formatDate, formatMonth } from '../src/lib/format.ts';

describe('the entries (CLAUDE.md gotcha: module order)', () => {
  it.each(['entry-client.tsx', 'entry-server.tsx'])('%s imports lib/zod.ts, then the stylesheet, first', (entry) => {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports.slice(0, 2)).toEqual(["import './lib/zod.ts';", "import './styles.css';"]);
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
