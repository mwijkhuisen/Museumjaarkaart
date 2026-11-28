import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dbUrl, EXIT_CONFIG, migratorUrl } from '../src/db/migrate.ts';
import { HEARTBEAT_MAX_AGE_MS, healthy, touch } from '../src/heartbeat.ts';
import { EXIT_NOT_BUILT, EXIT_USAGE, parseSyncArgs, run } from '../src/main.ts';
import { writeTestKeys } from './auth/test-keys.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'mjk-test-'));
const USAGE = 'usage: main.ts <api|ssr|worker|media|migrate|healthcheck|sync-museums|admin|backup> [args]';
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
/** The api's config (P1e): the domain and the Access team and AUD, test values only. */
const API_ENV = { MJK_DOMAIN: 'mjk.test', CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: 'a'.repeat(64) };
/** A valid throw-away app_keys (P2a), so the api's later checks are the ones a test reaches. */
const KEYS_DIR = writeTestKeys().dir;

describe('run', () => {
  it.each([[[]], [['nope']]])('%j exits 2 with the usage line', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_NOT_BUILT);
    expect(lines).toEqual([USAGE]);
  });

  it.each([[['healthcheck', 'x']], [['migrate', 'x']], [['ssr', 'x']], [['media', 'x']]])(
    '%j is a usage error',
    async (argv) => {
      const lines: string[] = [];
      expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
      expect(lines).toEqual([USAGE]);
    },
  );

  it('backup with an argument is a usage error', async () => {
    const lines: string[] = [];
    expect(await run(['backup', 'x'], {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines).toEqual([USAGE]);
  });

  it('admin invite and user are built (no app_keys: 78; a usage error: 64)', async () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l) };
    expect(await run(['admin', 'invite', 'create'], {}, (l) => lines.push(l), undefined, io)).toBe(78);
    expect(await run(['admin', 'user', 'role'], {}, (l) => lines.push(l), undefined, io)).toBe(EXIT_USAGE);
  });

  it.each([
    [['sync-museums', '--bogus']],
    [['sync-museums', '--accept-drop', 'osm']],
    [['sync-museums', '--accept-drop']],
    [['sync-museums', '--seed', '--seed']],
    [['sync-museums', '--accept-changes', '--accept-changes']],
    [['sync-museums', '--accept-changes=yes']],
  ])('%j is a usage error', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines).toEqual([
      'usage: main.ts sync-museums [--dry-run] [--seed] [--accept-drop wikidata|rce] [--accept-changes]',
    ]);
  });

  it('sync-museums reads each flag once, --accept-changes included', () => {
    expect(parseSyncArgs([])).toEqual({ dryRun: false, seed: false, acceptDrop: null, acceptChanges: false });
    expect(parseSyncArgs(['--accept-changes', '--dry-run', '--accept-drop', 'rce'])).toEqual({
      dryRun: true,
      seed: false,
      acceptDrop: 'rce',
      acceptChanges: true,
    });
  });

  it.each([['worker'], ['api']])('%s takes no arguments', async (role) => {
    const lines: string[] = [];
    expect(await run([role, 'x'], {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines).toEqual([USAGE]);
  });

  it('api without a database setting exits 78 naming the setting, never its value', async () => {
    const lines: string[] = [];
    const env = { ...API_ENV, DATABASE_URL: 'mysql://user:Secret-Value-123@db/x' };
    const deps = { signal: AbortSignal.abort(), secretsDir: KEYS_DIR };
    expect(await run(['api'], env, (l) => lines.push(l), undefined, deps)).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['api: DATABASE_URL is not a postgres URL']);
    lines.length = 0;
    // No DATABASE_URL: production's file secret, which the sandbox does not have.
    expect(await run(['api'], API_ENV, (l) => lines.push(l), undefined, deps)).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['api: the file secret db_mjk_api is missing']);
  });

  it('api without a valid app_keys exits 78 naming the key, never a value', async () => {
    const lines: string[] = [];
    const empty = mkdtempSync(join(tmpdir(), 'mjk-nokeys-'));
    const env = { ...API_ENV, DATABASE_URL: 'postgres://u:p@db/x' };
    expect(
      await run(['api'], env, (l) => lines.push(l), undefined, { signal: AbortSignal.abort(), secretsDir: empty }),
    ).toBe(EXIT_CONFIG);
    writeFileSync(join(empty, 'app_keys'), `otp_pepper=${'A'.repeat(43)}\n`);
    expect(
      await run(['api'], env, (l) => lines.push(l), undefined, { signal: AbortSignal.abort(), secretsDir: empty }),
    ).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['api: app_keys: unreadable', 'api: app_keys: invite_pepper missing']);
  });

  it('api needs the domain and the Access team and AUD, exiting 78 for each before the database', async () => {
    const lines: string[] = [];
    const exit = (env: Record<string, string>) =>
      run(['api'], { DATABASE_URL: 'postgres://u:p@db/x', ...env }, (l) => lines.push(l), undefined, {
        signal: AbortSignal.abort(),
      });
    const { MJK_DOMAIN, CF_ACCESS_TEAM } = API_ENV;
    expect(await exit({})).toBe(EXIT_CONFIG);
    expect(await exit({ MJK_DOMAIN })).toBe(EXIT_CONFIG);
    expect(await exit({ MJK_DOMAIN, CF_ACCESS_TEAM })).toBe(EXIT_CONFIG);
    expect(await exit({ MJK_DOMAIN, CF_ACCESS_TEAM, CF_ACCESS_AUD: 'not-hex-Secret-Value' })).toBe(EXIT_CONFIG);
    expect(await exit({ ...API_ENV, CF_ACCESS_TEAM: 'evil.example/Secret-Value' })).toBe(EXIT_CONFIG);
    expect(lines).toEqual([
      'api: MJK_DOMAIN is missing',
      'api: CF_ACCESS_TEAM is missing',
      'api: CF_ACCESS_AUD is missing',
      'api: CF_ACCESS_AUD must be 64 lowercase hex characters',
      'api: CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens',
    ]);
  });

  it('ssr needs the brand, the domain and its own database login, exiting 78 for each', async () => {
    const lines: string[] = [];
    const exit = (env: Record<string, string>) =>
      run(['ssr'], env, (l) => lines.push(l), undefined, { signal: AbortSignal.abort() });
    expect(await exit({})).toBe(EXIT_CONFIG);
    expect(await exit({ MJK_BRAND_NAME: 'Testmerk' })).toBe(EXIT_CONFIG);
    const legal = { MJK_CONTROLLER_NAME: 'Test Beheerder', MJK_CONTACT_EMAIL: 'info@mjk.test' };
    expect(await exit({ MJK_BRAND_NAME: 'Testmerk', MJK_DOMAIN: 'mjk.test', ...legal })).toBe(EXIT_CONFIG);
    const url = 'mysql://user:Secret-Value-123@db/x';
    expect(await exit({ MJK_BRAND_NAME: 'Testmerk', MJK_DOMAIN: 'mjk.test', ...legal, DATABASE_URL: url })).toBe(
      EXIT_CONFIG,
    );
    expect(lines).toEqual([
      'ssr: MJK_BRAND_NAME is missing',
      'ssr: MJK_DOMAIN is missing',
      'ssr: the file secret db_mjk_ssr is missing',
      'ssr: DATABASE_URL is not a postgres URL',
    ]);
  });

  it.each([[['sync-museums', '--dry-run']], [['worker']], [['api']]])(
    '%j without a database setting is a config error that never prints the URL',
    async (argv) => {
      const lines: string[] = [];
      const env = { ...API_ENV, DATABASE_URL: 'mysql://user:Secret-Value-123@db/x' };
      expect(await run(argv, env, (l) => lines.push(l), undefined, { signal: AbortSignal.abort() })).toBe(EXIT_CONFIG);
      expect(lines.join('\n')).not.toMatch(/Secret-Value|mysql/);
    },
  );

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
  it('an unknown role exits 2', () => {
    const r = spawnSync(process.execPath, [MAIN, 'nope'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  it('backup without its config exits 78 and logs only a fixed code', () => {
    const r = spawnSync(process.execPath, [MAIN, 'backup'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toContain('config_invalid');
    expect(r.stderr).not.toMatch(/secret|password|postgres:/i);
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
