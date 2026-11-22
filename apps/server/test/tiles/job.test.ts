import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { BUILDS_URL } from '../../src/tiles/builds.ts';
import type { TileLimits } from '../../src/tiles/header.ts';
import { bboxArg, tilesRefreshJob, tilesRollbackJob } from '../../src/tiles/job.ts';
import type { JobError } from '../../src/worker/types.ts';
import { fakeBucket } from './fake-r2.ts';

// The job end to end: a fake `pmtiles` (a script that copies the committed fixture), msw for Protomaps and
// for R2, a temporary build directory. Nothing here touches the network or a real credential.

const FIXTURE = join(import.meta.dirname, '../../../web/e2e/tiles/fixture.pmtiles');
const WORLD = { latMin: -85.06, latMax: 85.06, lonMin: -180, lonMax: 180 };
const LIMITS: TileLimits = { minBytes: 1000, maxBytes: 10 * 1024 * 1024, box: WORLD };
const KEY_ID = 'AKIATESTKEY0002';
const SECRET = 'test-secret-value-0002';
const NOW = new Date('2026-11-22T10:00:00Z');

let root: string;
let buildDir: string;
let secretPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mjk-tiles-job-'));
  buildDir = join(root, 'tiles-build');
  mkdirSync(buildDir);
  secretPath = join(root, 'r2_media_rw');
  writeFileSync(secretPath, `[default]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`);
});

/** A `pmtiles` that records its arguments and environment, then runs `body`. `$4` is the output path. */
function fakeBinary(body: string): string {
  const path = join(root, 'pmtiles');
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${root}/args\nprintf '%s\\n' "$TMPDIR" "$GOMEMLIMIT" "$HOME" "$PATH" > ${root}/env\nenv > ${root}/fullenv\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
const copyFixture = `cp ${FIXTURE} "$4" && : > "$TMPDIR/pmtiles-temp-1"`;

const builds = (...dates: string[]) =>
  server.use(
    http.get(BUILDS_URL, () =>
      HttpResponse.json(dates.map((d) => ({ key: `${d}.pmtiles`, version: '4.15.2', size: 1 }))),
    ),
  );

function job(binary: string, over: { signal?: AbortSignal; env?: Record<string, string> } = {}) {
  const mem = memoryLogger('worker');
  const handler = tilesRefreshJob({
    logger: mem.logger,
    env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media', ...over.env },
    buildDir,
    pmtiles: binary,
    limits: LIMITS,
    secretPath,
    now: () => NOW,
  });
  const run = () => handler({}, { signal: over.signal ?? new AbortController().signal });
  return { run, ...mem };
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as JobError & { code: string; retry: boolean };
  }
  throw new Error('expected the job to fail');
};

describe('tiles_refresh', () => {
  it('extracts the national box, uploads, flips current.json and leaves the build directory empty', async () => {
    const r2 = fakeBucket();
    builds('20261110', '20261120', '20261115');
    const { run, lines } = job(fakeBinary(copyFixture));
    await run();

    expect(readFileSync(join(root, 'args'), 'utf8').trimEnd().split('\n')).toEqual([
      'extract',
      '--quiet',
      'https://build.protomaps.com/20261120.pmtiles',
      join(buildDir, 'nl-20261120.pmtiles'),
      '--bbox=3.2,50.7,7.3,53.7',
    ]);
    const [tmpdirSeen, gomem] = readFileSync(join(root, 'env'), 'utf8').split('\n');
    expect(tmpdirSeen).toBe(buildDir);
    expect(gomem).toBe('300MiB');
    expect(r2.log).toEqual([
      'GET tiles/current.json',
      'GET tiles/current.json',
      'PUT tiles/nl-20261120.pmtiles',
      'HEAD tiles/nl-20261120.pmtiles',
      'PUT tiles/current.json',
    ]);
    const stored = r2.objects.get('tiles/nl-20261120.pmtiles');
    expect(Buffer.from(stored?.body ?? []).equals(readFileSync(FIXTURE))).toBe(true);
    expect(r2.current()).toEqual({ file: 'nl-20261120.pmtiles', previous: null });
    expect(readdirSync(buildDir)).toEqual([]);
    expect(lines().map((l) => l.msg)).toEqual(['tiles_build_found', 'tiles_published']);
  });

  it('passes go-pmtiles a fixed environment and not the worker secrets or its own', async () => {
    fakeBucket();
    builds('20261120');
    await job(fakeBinary(copyFixture), { env: { GOMEMLIMIT: '250MiB' } }).run();
    const env = readFileSync(join(root, 'fullenv'), 'utf8');
    expect(readFileSync(join(root, 'env'), 'utf8').split('\n')[1]).toBe('250MiB');
    expect(env).not.toContain(KEY_ID);
    expect(env).not.toContain(SECRET);
    expect(env).not.toContain('MJK_R2');
  });

  it('keeps the previous file and deletes the one two back, after the flip', async () => {
    const r2 = fakeBucket();
    const binary = fakeBinary(copyFixture);
    for (const date of ['20260801', '20261101', '20261120']) {
      builds(date);
      await job(binary).run();
    }
    expect(r2.current()).toEqual({ file: 'nl-20261120.pmtiles', previous: 'nl-20261101.pmtiles' });
    expect([...r2.objects.keys()].sort()).toEqual([
      'tiles/current.json',
      'tiles/nl-20261101.pmtiles',
      'tiles/nl-20261120.pmtiles',
    ]);
    expect(r2.log.slice(-2)).toEqual(['PUT tiles/current.json', 'DELETE tiles/nl-20260801.pmtiles']);
  });

  it('is done at once when the newest build is current or was rolled back from', async () => {
    const r2 = fakeBucket();
    r2.put('tiles/current.json', '{"file":"nl-20261120.pmtiles","previous":"nl-20261101.pmtiles"}');
    const binary = fakeBinary(copyFixture);
    for (const date of ['20261120', '20261101']) {
      builds(date);
      const { run, lines } = job(binary);
      await run();
      expect(lines().map((l) => l.msg)).toEqual(['tiles_build_found', 'tiles_up_to_date']);
    }
    expect(existsSync(join(root, 'args'))).toBe(false);
    expect(r2.log.every((l) => l === 'GET tiles/current.json')).toBe(true);
  });

  it('a failed extract is tiles_extract_failed (retried), uploads nothing and empties the directory', async () => {
    const r2 = fakeBucket();
    builds('20261120');
    const { run, lines } = job(
      fakeBinary(`cp ${FIXTURE} "$4"; : > "$TMPDIR/pmtiles-temp-1"; echo "secret-ish https://x" >&2; exit 3`),
    );
    const err = await failure(run());
    expect(err).toMatchObject({ code: 'tiles_extract_failed', retry: true });
    expect(readdirSync(buildDir)).toEqual([]);
    expect(r2.log).toEqual(['GET tiles/current.json']);
    expect(lines().find((l) => l.msg === 'tiles_extract_failed')).toMatchObject({ status: 3 });
    // The binary's output never reaches the log.
    expect(JSON.stringify(lines())).not.toContain('secret-ish');
  });

  it('a missing binary is tiles_extract_failed too', async () => {
    fakeBucket();
    builds('20261120');
    expect(await failure(job(join(root, 'no-such-binary')).run())).toMatchObject({ code: 'tiles_extract_failed' });
  });

  it.each([
    ['garbage', `echo not a tile file > "$4"`],
    ['a truncated file', `head -c 500000 ${FIXTURE} > "$4"`],
    ['no file at all', `: > "$TMPDIR/pmtiles-temp-1"`],
  ])('%s is tiles_bad_file (final): nothing is uploaded and the directory is empty', async (_name, body) => {
    const r2 = fakeBucket();
    builds('20261120');
    const { run, lines } = job(fakeBinary(body));
    expect(await failure(run())).toMatchObject({ code: 'tiles_bad_file', retry: false });
    expect(readdirSync(buildDir)).toEqual([]);
    expect(r2.log).toEqual(['GET tiles/current.json']);
    expect(lines().find((l) => l.msg === 'tiles_bad_file')?.why).toMatch(/^[a-z_]+$/);
  });

  it('a file outside the size limits is tiles_bad_file', async () => {
    fakeBucket();
    builds('20261120');
    const handler = tilesRefreshJob({
      logger: memoryLogger().logger,
      env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media' },
      buildDir,
      pmtiles: fakeBinary(copyFixture),
      limits: { ...LIMITS, maxBytes: 1000 },
      secretPath,
      now: () => NOW,
    });
    expect(await failure(handler({}, { signal: new AbortController().signal }))).toMatchObject({
      code: 'tiles_bad_file',
    });
  });

  it('empties the directory before it extracts', async () => {
    fakeBucket();
    builds('20261120');
    writeFileSync(join(buildDir, 'old.pmtiles'), 'x');
    mkdirSync(join(buildDir, 'sub'));
    writeFileSync(join(buildDir, 'sub', 'y'), 'y');
    await job(fakeBinary(`ls "$TMPDIR" > ${root}/before; ${copyFixture}`)).run();
    expect(readFileSync(join(root, 'before'), 'utf8')).toBe('');
  });

  it('an abort kills the extract, waits for it, empties the directory and fails tiles_aborted', async () => {
    const r2 = fakeBucket();
    builds('20261120');
    const ac = new AbortController();
    const { run } = job(fakeBinary(`: > "$TMPDIR/partial"; : > ${root}/started; exec sleep 30`), { signal: ac.signal });
    const running = failure(run());
    while (!existsSync(join(root, 'started'))) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(await running).toMatchObject({ code: 'tiles_aborted', retry: true });
    expect(readdirSync(buildDir)).toEqual([]);
    expect(r2.log).toEqual(['GET tiles/current.json']);
  });

  it('a build list that fails, is not a list or has no build fails with a fixed code before R2 is used', async () => {
    const r2 = fakeBucket();
    server.use(http.get(BUILDS_URL, () => new HttpResponse(null, { status: 500 })));
    expect(await failure(job(fakeBinary(copyFixture)).run())).toMatchObject({
      code: 'tiles_builds_unavailable',
      retry: true,
    });
    server.use(http.get(BUILDS_URL, () => new HttpResponse('<html>')));
    expect(await failure(job(fakeBinary(copyFixture)).run())).toMatchObject({
      code: 'tiles_builds_invalid',
      retry: false,
    });
    builds();
    expect(await failure(job(fakeBinary(copyFixture)).run())).toMatchObject({ code: 'tiles_no_build', retry: false });
    expect(r2.log).toEqual([]);
  });

  it('config is read when the job runs: a missing secret or bucket fails at once with a store code, before any request', async () => {
    const { run } = job(fakeBinary(copyFixture), { env: { MJK_R2_BUCKET_MEDIA: '' } });
    expect(await failure(run())).toMatchObject({ code: 'store_bucket_invalid', retry: false });
    const missing = tilesRefreshJob({
      logger: memoryLogger().logger,
      env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media' },
      buildDir,
      secretPath: join(root, 'nope'),
    });
    expect(await failure(missing({}, { signal: new AbortController().signal }))).toMatchObject({
      code: 'store_secret_missing',
      retry: false,
    });
  });

  it('a build directory that is missing is tiles_build_dir', async () => {
    fakeBucket();
    builds('20261120');
    const handler = tilesRefreshJob({
      logger: memoryLogger().logger,
      env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media' },
      buildDir: join(root, 'missing'),
      pmtiles: fakeBinary(copyFixture),
      secretPath,
      now: () => NOW,
    });
    expect(await failure(handler({}, { signal: new AbortController().signal }))).toMatchObject({
      code: 'tiles_build_dir',
      retry: false,
    });
  });

  it('logs fixed codes and counts: no key, URL, credential or path', async () => {
    fakeBucket();
    builds('20261120');
    const { run, lines } = job(fakeBinary(copyFixture));
    await run();
    const log = JSON.stringify(lines());
    for (const bad of [KEY_ID, SECRET, 'protomaps', 'r2.test', 'https://', 'tiles/', buildDir])
      expect(log).not.toContain(bad);
  });
});

describe('tiles_rollback', () => {
  it('points current.json back at the previous file', async () => {
    const r2 = fakeBucket();
    r2.put('tiles/current.json', '{"file":"nl-20261120.pmtiles","previous":"nl-20261101.pmtiles"}');
    r2.put('tiles/nl-20261101.pmtiles', 'x');
    const { logger, lines } = memoryLogger();
    await tilesRollbackJob({
      logger,
      env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media' },
      secretPath,
    })({}, { signal: new AbortController().signal });
    expect(r2.current()).toEqual({ file: 'nl-20261101.pmtiles', previous: 'nl-20261120.pmtiles' });
    expect(lines().map((l) => l.msg)).toEqual(['tiles_rolled_back']);
  });

  it('fails tiles_no_previous when there is none', async () => {
    const r2 = fakeBucket();
    r2.put('tiles/current.json', '{"file":"nl-20261120.pmtiles","previous":null}');
    const handler = tilesRollbackJob({
      logger: memoryLogger().logger,
      env: { MJK_R2_ENDPOINT: 'https://r2.test', MJK_R2_BUCKET_MEDIA: 'mjk-media' },
      secretPath,
    });
    expect(await failure(handler({}, { signal: new AbortController().signal }))).toMatchObject({
      code: 'tiles_no_previous',
      retry: false,
    });
  });
});

describe('the extract arguments', () => {
  it('the bbox is the national box in go-pmtiles order: west,south,east,north', () => {
    expect(bboxArg()).toBe('--bbox=3.2,50.7,7.3,53.7');
  });
});
