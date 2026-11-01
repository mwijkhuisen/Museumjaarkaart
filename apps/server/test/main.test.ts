import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dbUrl, EXIT_CONFIG, migratorUrl } from '../src/db/migrate.ts';
import { HEARTBEAT_MAX_AGE_MS, healthy, touch } from '../src/heartbeat.ts';
import { EXIT_NOT_BUILT, EXIT_USAGE, run } from '../src/main.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'mjk-test-'));
const USAGE = 'usage: main.ts <api|ssr|worker|migrate|healthcheck|sync-museums|admin|backup> [args]';
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('run', () => {
  it.each([[[]], [['nope']]])('%j exits 2 with the usage line', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_NOT_BUILT);
    expect(lines).toEqual([USAGE]);
  });

  it.each([[['healthcheck', 'x']], [['migrate', 'x']]])('%j is a usage error', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines).toEqual([USAGE]);
  });

  it.each([
    [['api']],
    [['ssr']],
    [['worker']],
    [['backup']],
    [['sync-museums', '--dry-run']],
    [['admin', 'invite', 'create']],
  ])('%j is not built yet', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_NOT_BUILT);
    expect(lines).toEqual([`role ${argv[0]} is not built yet`]);
  });

  it('migrate without a database setting is a config error', async () => {
    const lines: string[] = [];
    expect(await run(['migrate'], { DATABASE_URL: 'mysql://x/y' }, (l) => lines.push(l))).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['migrate: DATABASE_URL is not a postgres URL']);
    lines.length = 0;
    expect(await run(['migrate'], { DATABASE_URL: 'not a url' }, (l) => lines.push(l))).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['migrate: DATABASE_URL is not a URL']);
  });
});

describe('real CLI', () => {
  it.each([['nope'], ['worker']])('%s exits 2', (role) => {
    const r = spawnSync(process.execPath, [MAIN, role], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('healthcheck', () => {
  it('exits 0 while fresh, 1 when 121 s old or missing', async () => {
    const path = join(tmp(), 'hb');
    expect(await run(['healthcheck'], {}, () => {}, path)).toBe(1);
    touch(path);
    expect(await run(['healthcheck'], {}, () => {}, path)).toBe(0);
    const old = new Date(Date.now() - 121_000);
    utimesSync(path, old, old);
    expect(await run(['healthcheck'], {}, () => {}, path)).toBe(1);
  });
});

describe('heartbeat', () => {
  it('is healthy for 120 s after a touch, and not when missing', () => {
    const path = join(tmp(), 'hb');
    expect(healthy(path)).toBe(false);
    touch(path);
    expect(healthy(path)).toBe(true);
    const old = new Date(Date.now() - HEARTBEAT_MAX_AGE_MS - 1000);
    utimesSync(path, old, old);
    expect(healthy(path)).toBe(false);
  });
});

describe('migratorUrl', () => {
  it('takes DATABASE_URL when set', () => {
    const url = migratorUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/x?sslmode=disable' });
    expect(url).toBeInstanceOf(URL);
    expect(migratorUrl({ DATABASE_URL: 'not a url' })).toBe('DATABASE_URL is not a URL');
  });

  it('otherwise logs in as mjk_migrator on db with a URL-safe file secret', () => {
    const dir = tmp();
    expect(migratorUrl({}, dir)).toBe('the file secret db_mjk_migrator is missing');
    writeFileSync(join(dir, 'db_mjk_migrator'), 'Abc-123_xyz-456_DEF-789_gh\n');
    expect(String(migratorUrl({}, dir))).toBe(
      'postgres://mjk_migrator:Abc-123_xyz-456_DEF-789_gh@db:5432/mjk?sslmode=disable',
    );
    writeFileSync(join(dir, 'db_mjk_migrator'), 'two\nlines');
    expect(migratorUrl({}, dir)).toBe('the file secret db_mjk_migrator is missing');
    for (const bad of ['p%41ss-but-long-enough-0123', 'p@ss/w:rd=+but-long-enough-0123', 'short_but_ok_chars']) {
      writeFileSync(join(dir, 'db_mjk_migrator'), bad);
      expect(migratorUrl({}, dir)).toMatch(/must be 24 or more/);
    }
  });
});

describe('dbUrl', () => {
  it('logs mjk_api in with its own file secret, never the migrator one', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'db_mjk_migrator'), 'Abc-123_xyz-456_DEF-789_gh');
    expect(dbUrl('mjk_api', {}, dir)).toBe('the file secret db_mjk_api is missing');
    writeFileSync(join(dir, 'db_mjk_api'), 'Api-123_xyz-456_DEF-789_gh\n');
    expect(String(dbUrl('mjk_api', {}, dir))).toBe(
      'postgres://mjk_api:Api-123_xyz-456_DEF-789_gh@db:5432/mjk?sslmode=disable',
    );
  });

  it('never throws and never puts a secret in an error, for any file content', () => {
    const dir = tmp();
    const missing = 'the file secret db_mjk_migrator is missing';
    const weak = 'the file secret db_mjk_migrator must be 24 or more characters of A-Z a-z 0-9 _ -';
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (content) => {
        writeFileSync(join(dir, 'db_mjk_migrator'), content);
        const out = dbUrl('mjk_migrator', {}, dir);
        if (typeof out === 'string') {
          expect([missing, weak]).toContain(out);
        } else {
          expect(out.password).toBe(content.trim());
          expect(out.password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('runMigrate', () => {
  it('never logs the password, even when dbmate prints the URL', async () => {
    const bin = tmp();
    const dbmate = '#!/bin/sh\necho "out $DATABASE_URL"\necho "err $DATABASE_URL" >&2\nexit 1\n';
    writeFileSync(join(bin, 'dbmate'), dbmate, { mode: 0o755 });
    const lines: string[] = [];
    const env = { PATH: bin, DATABASE_URL: 'postgres://u:Pa55-word%25x@localhost:5432/x' };
    expect(await run(['migrate'], env, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).not.toMatch(/Pa55-word/);
    expect(lines).toEqual(['migrate: dbmate failed (exit 1)', 'migrate: out [redacted]', 'migrate: err [redacted]']);
  });
});
