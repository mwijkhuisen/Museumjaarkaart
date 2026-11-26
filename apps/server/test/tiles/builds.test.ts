import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { BUILDS_URL, fetchBuilds, newestBuild } from '../../src/tiles/builds.ts';
import { JobError } from '../../src/worker/types.ts';

const NOW = new Date('2026-11-22T10:00:00Z');
const list = (...entries: unknown[]) => JSON.stringify(entries);
const entry = (key: string, version = '4.15.2') => ({ key, version, size: 1 });

describe('newestBuild', () => {
  it('takes the newest build and builds the source URL from the key only', () => {
    const b = newestBuild(list(entry('20261115.pmtiles'), entry('20261121.pmtiles'), entry('20261118.pmtiles')), NOW);
    expect(b).toEqual({ date: '20261121', url: 'https://build.protomaps.com/20261121.pmtiles' });
  });

  it('skips keys that are not a build, dates that do not exist, the future and another schema major', () => {
    const b = newestBuild(
      list(
        entry('20261120.pmtiles'),
        entry('20261124.pmtiles'), // after tomorrow
        entry('20261199.pmtiles'), // no such date
        entry('20261121.pmtiles', '5.0.0'), // another major
        entry('20261121.pmtiles.gz'),
        entry('../20261121.pmtiles'),
        entry('https://evil.example/20261122.pmtiles'),
        entry('19991231.pmtiles'),
        { key: '20261122.pmtiles' },
        { key: 20261122, version: '4.1.1' },
        null,
        'x',
        [],
      ),
      NOW,
    );
    expect(b?.date).toBe('20261120');
  });

  it('allows tomorrow in UTC (clock skew)', () => {
    expect(newestBuild(list(entry('20261123.pmtiles')), NOW)?.date).toBe('20261123');
  });

  it('drops a date that is listed twice with two versions', () => {
    const b = newestBuild(
      list(entry('20261121.pmtiles', '4.1.1'), entry('20261121.pmtiles', '4.2.0'), entry('20261120.pmtiles')),
      NOW,
    );
    expect(b?.date).toBe('20261120');
  });

  it('is undefined when nothing qualifies', () => {
    expect(newestBuild(list(), NOW)).toBeUndefined();
  });

  it('refuses text that is not a JSON array with tiles_builds_invalid', () => {
    for (const text of ['', 'nope', '{"key":"20261121.pmtiles"}', 'null']) {
      expect(() => newestBuild(text, NOW)).toThrow(
        expect.objectContaining({ code: 'tiles_builds_invalid', retry: false }),
      );
    }
  });
});

describe('fetchBuilds', () => {
  const run = () => fetchBuilds(new AbortController().signal);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof JobError ? e.code : 'other'),
    );

  it('returns the text of a 200', async () => {
    server.use(http.get(BUILDS_URL, () => new HttpResponse('[]')));
    expect(await run()).toBe('[]');
  });

  it('a status, a redirect and a network error are tiles_builds_unavailable', async () => {
    server.use(http.get(BUILDS_URL, () => new HttpResponse(null, { status: 503 })));
    expect(await code(run())).toBe('tiles_builds_unavailable');
    server.use(
      http.get(
        BUILDS_URL,
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
      ),
    );
    expect(await code(run())).toBe('tiles_builds_unavailable');
    server.use(http.get(BUILDS_URL, () => HttpResponse.error()));
    expect(await code(run())).toBe('tiles_builds_unavailable');
  });

  it('a body over the cap is tiles_builds_invalid', async () => {
    server.use(http.get(BUILDS_URL, () => new HttpResponse('x'.repeat(1024 * 1024 + 1))));
    expect(await code(run())).toBe('tiles_builds_invalid');
  });

  it('an aborted signal is tiles_aborted', async () => {
    server.use(http.get(BUILDS_URL, () => new HttpResponse('[]')));
    const ac = new AbortController();
    ac.abort();
    expect(await code(fetchBuilds(ac.signal))).toBe('tiles_aborted');
  });
});
