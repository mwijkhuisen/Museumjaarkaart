import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCLUDED_TABLE_DATA, parseBackupConfig, pgDumpEnv, resticEnv } from '../../src/backup/plan.ts';
import { type BackupDeps, runBackup } from '../../src/backup/run.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { createMigratedDb, type TestDb } from '../db.ts';
import { CATALOGUE_TOTAL, seedCatalogue } from '../seed-catalogue.ts';

// The `backup` role against a real PostgreSQL 18 and, for the full run, a restic repository on
// the MinIO stand-in (A§18; no bucket lock: that is proven on the box). Needs:
//
//   DATABASE_URL        a superuser of the throw-away cluster (as every integration test)
//   PG_LOG_CONTAINER    that cluster's container: pg_dump 18 and pg_restore 18 run inside it
//                       through a shim, because the runner's own PostgreSQL client is older
//   MJK_TEST_MINIO_URL  the stand-in's endpoint, e.g. http://127.0.0.1:59000
//   MJK_TEST_MINIO_ACCESS_KEY, MJK_TEST_MINIO_SECRET_KEY  its root credentials
//   MJK_TEST_RESTIC     the restic 0.19.1 binary (default: `restic` on PATH)
//
// The MinIO part is skipped locally when MJK_TEST_MINIO_URL is unset and fails under CI.

const exec = promisify(execFile);
const container = process.env.PG_LOG_CONTAINER ?? '';
const minioUrl = process.env.MJK_TEST_MINIO_URL ?? '';
const resticBin = process.env.MJK_TEST_RESTIC ?? 'restic';

const tmp = () => mkdtempSync(join(tmpdir(), 'mjk-bk-it-'));
const rnd = (bytes = 18) => randomBytes(bytes).toString('base64url');

/** Runs a command in the PostgreSQL container, as `user`. */
async function inPg(args: string[], user = 'root'): Promise<string> {
  const { stdout } = await exec('docker', ['exec', '-u', user, container, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A shell script, mode 0755. */
function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The pg_dump shim: records the environment it was started with, then runs pg_dump 18 inside the
 * PostgreSQL container with the role's own pgpass (copied in, port mapped to the container's)
 * and PG* variables, and copies the dump back to the path the role asked for.
 */
function pgDumpShim(dir: string, trace: string): string {
  return script(
    join(dir, 'pg_dump'),
    `trace=${trace}; cid=${container}
env | sort > "$trace"
out=
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n-1))
  case "$a" in --file=*) out=\${a#--file=} ;; *) set -- "$@" "$a" ;; esac
done
tmp=/tmp/mjk-shim-$$
docker exec -u root "$cid" mkdir -p "$tmp" || exit 1
sed 's/^127\\.0\\.0\\.1:[0-9]*:/127.0.0.1:5432:/' "$PGPASSFILE" > "$trace.pgpass"
docker cp "$trace.pgpass" "$cid:$tmp/pgpass" || exit 1
rm -f "$trace.pgpass"
docker exec -u root "$cid" chmod 600 "$tmp/pgpass" || exit 1
docker exec -u root -e PGHOST -e PGUSER -e PGDATABASE -e PGAPPNAME -e PGCONNECT_TIMEOUT -e PGSSLMODE \\
  -e PGPORT=5432 -e "PGPASSFILE=$tmp/pgpass" "$cid" pg_dump "$@" "--file=$tmp/out.dump"
rc=$?
if [ $rc -eq 0 ]; then docker cp "$cid:$tmp/out.dump" "$out" || rc=1; fi
docker exec -u root "$cid" rm -rf "$tmp"
exit $rc`,
  );
}

/** A restic shim that records every environment it is started with, then runs the real binary. */
const resticShim = (dir: string, trace: string) =>
  script(join(dir, 'restic'), `{ echo '#call'; env | sort; } >> ${trace}\nexec ${resticBin} "$@"`);

/** The environment keys of each call recorded by a shim. */
const keysOf = (trace: string): string[][] =>
  readFileSync(trace, 'utf8')
    .split('#call\n')
    .filter((s) => s !== '')
    .map((call) =>
      call
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.slice(0, l.indexOf('='))),
    );

let db: TestDb;
let admin: pg.Client;
const secretValues: string[] = [];

type Setup = {
  root: string;
  secretsDir: string;
  stagingDir: string;
  originalsDir: string;
  tmpDir: string;
  shims: string;
};

function setup(): Setup {
  const root = tmp();
  const s: Setup = {
    root,
    secretsDir: join(root, 'secrets'),
    stagingDir: join(root, 'staging'),
    originalsDir: join(root, 'originals'),
    tmpDir: join(root, 'tmp'),
    shims: join(root, 'shims'),
  };
  for (const d of [s.secretsDir, s.stagingDir, s.originalsDir, s.tmpDir, s.shims]) mkdirSync(d);
  writeFileSync(join(s.originalsDir, 'a.jpg'), randomBytes(2048));
  mkdirSync(join(s.originalsDir, 'sub'));
  writeFileSync(join(s.originalsDir, 'sub', 'b.png'), randomBytes(1024));
  return s;
}

const deps = (s: Setup, extra: Partial<BackupDeps> = {}): BackupDeps => ({
  secretsDir: s.secretsDir,
  stagingDir: s.stagingDir,
  originalsDir: s.originalsDir,
  tmpDir: s.tmpDir,
  ...extra,
});

beforeAll(async () => {
  if (container === '') throw new Error('PG_LOG_CONTAINER must name the PostgreSQL container');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error('PG_LOG_CONTAINER is not a container name');
  db = await createMigratedDb();
  admin = new pg.Client({ connectionString: db.urls.admin });
  await admin.connect();
  await seedCatalogue(db);
  // The tables A§17.6 excludes: only `job` exists in P1e, the rest arrive with P2. The test
  // creates stand-ins so that every name on the list is proven, each with a row of data.
  await admin.query("INSERT INTO job (kind) VALUES ('museum_sync'), ('museum_sync')");
  for (const t of EXCLUDED_TABLE_DATA.filter((x) => x !== 'job')) {
    await admin.query(`CREATE TABLE public.${t} (id int PRIMARY KEY, note text)`);
    await admin.query(`INSERT INTO public.${t} VALUES (1, 'must not be in the backup')`);
  }
  secretValues.push(...[db.urls.mjk_backup, new URL(db.urls.mjk_backup).password]);
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

describe('failures, with fake binaries', () => {
  const env = () => ({
    DATABASE_URL: db.urls.mjk_backup,
    MJK_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com',
    MJK_R2_BUCKET_BACKUP: 'mjk-backup',
  });
  const withSecrets = (s: Setup) => {
    writeFileSync(join(s.secretsDir, 'restic_password'), `${rnd()}\n`);
    writeFileSync(join(s.secretsDir, 'r2_backup_put'), '[default]\naws_access_key_id=x\naws_secret_access_key=y\n');
    return s;
  };

  it('a failing pg_dump exits 70, removes its partial dump and the pgpass, and never starts restic', async () => {
    const s = withSecrets(setup());
    const ran = join(s.root, 'restic-ran');
    const pgDump = script(
      join(s.shims, 'pg_dump'),
      `for a in "$@"; do case "$a" in --file=*) echo partial > "$(echo "$a" | cut -c8-)" ;; esac; done\nexit 1`,
    );
    const restic = script(join(s.shims, 'restic'), `touch ${ran}`);
    const { logger, lines } = memoryLogger('backup');
    expect(await runBackup(env(), deps(s, { logger, pgDumpBin: pgDump, resticBin: restic }))).toBe(70);
    expect(lines().map((l) => l.msg)).toEqual(['backup_started', 'backup_failed']);
    expect(lines()[1]).toMatchObject({ step: 'pg_dump', exit: 1 });
    expect(existsSync(ran)).toBe(false);
    expect(readdirSync(s.stagingDir)).toEqual([]);
    expect(readdirSync(s.tmpDir)).toEqual([]);
  });

  it('an empty dump exits 70', async () => {
    const s = withSecrets(setup());
    const pgDump = script(
      join(s.shims, 'pg_dump'),
      'for a in "$@"; do case "$a" in --file=*) : > "$(echo "$a" | cut -c8-)" ;; esac; done',
    );
    const { logger, lines } = memoryLogger('backup');
    expect(await runBackup(env(), deps(s, { logger, pgDumpBin: pgDump }))).toBe(70);
    expect(lines()[1]).toMatchObject({ msg: 'backup_failed', step: 'dump_empty' });
    expect(readdirSync(s.stagingDir)).toEqual([]);
  });

  it('maps restic: an unreachable repository is 69, a wrong password 78, a partial snapshot 70; the dump is always removed', async () => {
    const pgDump = (s: Setup) =>
      script(
        join(s.shims, 'pg_dump'),
        'for a in "$@"; do case "$a" in --file=*) echo dump > "$(echo "$a" | cut -c8-)" ;; esac; done',
      );
    const cases: [name: string, restic: string, exit: number, msg: string][] = [
      ['probe fails', 'exit 1', 69, 'repo_unavailable'],
      ['wrong password', 'exit 12', 78, 'config_invalid'],
      ['backup fails', 'case "$*" in *backup*) exit 1 ;; esac', 70, 'backup_failed'],
      ['backup incomplete', 'case "$*" in *backup*) exit 3 ;; esac', 70, 'restic_incomplete'],
      ['restic missing', '', 69, 'repo_unavailable'],
    ];
    for (const [name, body, exit, msg] of cases) {
      const s = withSecrets(setup());
      const bin = name === 'restic missing' ? join(s.shims, 'no-such-restic') : script(join(s.shims, 'restic'), body);
      const { logger, lines } = memoryLogger('backup');
      expect(await runBackup(env(), deps(s, { logger, pgDumpBin: pgDump(s), resticBin: bin })), name).toBe(exit);
      expect(lines().at(-1)?.msg, name).toBe(msg);
      expect(readdirSync(s.stagingDir), name).toEqual([]);
      expect(readdirSync(s.tmpDir), name).toEqual([]);
    }
  });

  it('refuses a missing repository (restic exit 10): exit 78, repo_missing, never init', async () => {
    const s = withSecrets(setup());
    const log = join(s.root, 'calls');
    const pgDump = script(
      join(s.shims, 'pg_dump'),
      'for a in "$@"; do case "$a" in --file=*) echo dump > "$(echo "$a" | cut -c8-)" ;; esac; done',
    );
    const restic = script(
      join(s.shims, 'restic'),
      `echo "$*" >> ${log}\ncase "$*" in *cat*) exit 10 ;; esac\ncase "$*" in *backup*) echo '{"message_type":"summary","files_new":3,"snapshot_id":"abcdef0123456789"}' ;; esac`,
    );
    const { logger, lines } = memoryLogger('backup');
    expect(await runBackup(env(), deps(s, { logger, pgDumpBin: pgDump, resticBin: restic }))).toBe(78);
    expect(lines().map((l) => l.msg)).toEqual(['backup_started', 'dump_done', 'config_invalid']);
    expect(lines().at(-1)).toMatchObject({ code: 'repo_missing' });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('cat config');
    // Never init, forget or prune.
    expect(calls.join('\n')).not.toMatch(/init|forget|prune/);
    expect(readdirSync(s.stagingDir)).toEqual([]);
    expect(readdirSync(s.tmpDir)).toEqual([]);
  });
});

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('restic on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  describe('the full run: pg_dump, restic and the MinIO stand-in', () => {
    const accessKey = process.env.MJK_TEST_MINIO_ACCESS_KEY ?? '';
    const secretKey = process.env.MJK_TEST_MINIO_SECRET_KEY ?? '';
    const bucket = `mjk-bk-${process.pid}-${randomBytes(3).toString('hex')}`;
    const resticPassword = rnd(24);
    let s: Setup;
    let pgTrace: string;
    let resticTrace: string;
    let logs: ReturnType<typeof memoryLogger>;
    let runEnv: Record<string, string>;
    let exits: number[];

    beforeAll(async () => {
      if (accessKey === '' || secretKey === '') throw new Error('MJK_TEST_MINIO_ACCESS_KEY and _SECRET_KEY are needed');
      s = setup();
      pgTrace = join(s.root, 'pg-env');
      resticTrace = join(s.root, 'restic-env');
      writeFileSync(join(s.secretsDir, 'restic_password'), `${resticPassword}\n`);
      writeFileSync(
        join(s.secretsDir, 'r2_backup_put'),
        `[default]\naws_access_key_id=${accessKey}\naws_secret_access_key=${secretKey}\n`,
      );
      secretValues.push(resticPassword, accessKey, secretKey);
      runEnv = {
        DATABASE_URL: db.urls.mjk_backup,
        MJK_R2_ENDPOINT: minioUrl,
        MJK_R2_BUCKET_BACKUP: bucket,
        MJK_R2_REGION: 'us-east-1',
      };
      // R2's bucket exists before the first run (the owner makes it); MinIO's does not, and restic
      // retries a missing bucket for minutes. A scratch repository in a prefix creates the bucket
      // and leaves the bucket root to the role.
      const parsedConfig = parseBackupConfig(runEnv);
      if (!parsedConfig.ok) throw new Error(parsedConfig.code);
      await exec(resticBin, ['--no-cache', '--quiet', 'init'], {
        env: {
          ...resticEnv(parsedConfig.config, s.secretsDir),
          RESTIC_REPOSITORY: `${parsedConfig.config.repository}/scratch`,
        },
      });
      logs = memoryLogger('backup');
      const d = deps(s, {
        logger: logs.logger,
        pgDumpBin: pgDumpShim(s.shims, pgTrace),
        resticBin: resticShim(s.shims, resticTrace),
      });
      // The first run finds no repository and refuses (78, repo_missing). Then the repository is
      // created as the owner does from the workstation (backup.md §3), and two runs back up.
      exits = [await runBackup(runEnv, d)];
      await exec(resticBin, ['--no-cache', '--quiet', 'init'], {
        env: { ...resticEnv(parsedConfig.config, s.secretsDir) },
      });
      exits.push(await runBackup(runEnv, d), await runBackup(runEnv, d));
    }, 300_000);

    const restic = async (...args: string[]) => {
      const parsed = parseBackupConfig(runEnv);
      if (!parsed.ok) throw new Error(parsed.code);
      const { stdout } = await exec(resticBin, ['--no-cache', ...args], {
        env: { ...resticEnv(parsed.config, s.secretsDir) },
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    };

    it('refuses before the repository exists, then exits 0 twice; it never creates the repository', () => {
      expect(exits).toEqual([78, 0, 0]);
      const msgs = logs.lines().map((l) => l.msg);
      expect(logs.lines().find((l) => l.msg === 'config_invalid')).toMatchObject({ code: 'repo_missing' });
      expect(msgs).toEqual([
        'backup_started',
        'dump_done',
        'config_invalid',
        'backup_started',
        'dump_done',
        'backup_done',
        'backup_started',
        'dump_done',
        'backup_done',
      ]);
    });

    it('logs the snapshot id of each run (eight hex digits, no path)', () => {
      const done = logs.lines().filter((l) => l.msg === 'backup_done');
      expect(done).toHaveLength(2);
      for (const l of done) expect(l.snapshot).toMatch(/^[0-9a-f]{8}$/);
    });

    it('lands one snapshot per run on the fixed host, with the dump and the originals', async () => {
      const snaps = JSON.parse(await restic('snapshots', '--json')) as {
        hostname: string;
        tags: string[];
        paths: string[];
      }[];
      expect(snaps).toHaveLength(2);
      for (const snap of snaps) {
        expect(snap.hostname).toBe('mjk');
        expect(snap.tags).toEqual(['nightly']);
        expect(snap.paths.sort()).toEqual([s.originalsDir, join(s.stagingDir, 'mjk.dump')].sort());
      }
      const listing = await restic('ls', 'latest');
      expect(listing).toContain(`${s.originalsDir}/a.jpg`);
      expect(listing).toContain(`${s.originalsDir}/sub/b.png`);
      expect(listing).toContain(join(s.stagingDir, 'mjk.dump'));
      await restic('check');
    }, 120_000);

    it('restores to a dump whose excluded tables have a structure and no data, the rest in full', async () => {
      const target = join(s.root, 'restored');
      await restic('restore', 'latest', '--target', target);
      const file = join(target, s.stagingDir, 'mjk.dump');
      expect(existsSync(file)).toBe(true);
      await inPg(['mkdir', '-p', '/tmp/mjk-restore']);
      await exec('docker', ['cp', file, `${container}:/tmp/mjk-restore/mjk.dump`]);
      try {
        const toc = await inPg(['pg_restore', '--list', '/tmp/mjk-restore/mjk.dump']);
        for (const t of EXCLUDED_TABLE_DATA) {
          expect(toc, `${t} structure`).toMatch(new RegExp(` TABLE public ${t} `));
          expect(toc, `${t} data`).not.toMatch(new RegExp(` TABLE DATA public ${t} `));
        }
        expect(toc).toMatch(/ TABLE DATA public museum /);
        expect(toc).toMatch(/ TABLE DATA public province /);

        // And a real restore into a throw-away database: row counts match, the excluded ones are empty.
        const name = `mjk_it_restore_${process.pid}`;
        await inPg(['createdb', name], 'postgres');
        try {
          await inPg(
            ['pg_restore', '--no-owner', '--exit-on-error', '-d', name, '/tmp/mjk-restore/mjk.dump'],
            'postgres',
          );
          const url = new URL(db.urls.admin);
          url.pathname = `/${name}`;
          const restored = new pg.Client({ connectionString: url.href });
          await restored.connect();
          try {
            const n = async (client: pg.Client, t: string) =>
              Number(((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0] as { n: string }).n);
            expect(await n(restored, 'museum')).toBe(CATALOGUE_TOTAL);
            expect(await n(restored, 'museum')).toBe(await n(admin, 'museum'));
            expect(await n(admin, 'job')).toBe(2);
            for (const t of EXCLUDED_TABLE_DATA) expect(await n(restored, t), t).toBe(0);
          } finally {
            await restored.end();
          }
        } finally {
          await exec('docker', ['exec', '-u', 'postgres', container, 'dropdb', '--if-exists', '--force', name]);
        }
      } finally {
        await inPg(['rm', '-rf', '/tmp/mjk-restore']);
      }
    }, 180_000);

    it('leaves no dump and no pgpass behind', () => {
      expect(readdirSync(s.stagingDir)).toEqual([]);
      expect(readdirSync(s.tmpDir)).toEqual([]);
    });

    it('gives each child exactly the environment built for it, and no secret value', () => {
      const pgKeys = Object.keys(pgDumpEnv(new URL(db.urls.mjk_backup), '/x')).sort();
      const parsed = parseBackupConfig(runEnv);
      if (!parsed.ok) throw new Error(parsed.code);
      const resticKeys = Object.keys(resticEnv(parsed.config)).sort();
      // The shims add the variables their own `sh` sets (PWD, SHLVL, _, OLDPWD); the real
      // binaries are started directly. Everything else must be on the list.
      const shellOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
      const strip = (keys: string[]) => keys.filter((k) => !shellOwn.has(k)).sort();
      expect(strip(keysOf(pgTrace)[0] ?? [])).toEqual(pgKeys);
      const resticCalls = keysOf(resticTrace);
      expect(resticCalls.length).toBeGreaterThanOrEqual(4);
      for (const call of resticCalls) expect(strip(call)).toEqual(resticKeys);
      const traces = readFileSync(pgTrace, 'utf8') + readFileSync(resticTrace, 'utf8');
      for (const v of secretValues) expect(traces).not.toContain(v);
      for (const name of ['DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESTIC_PASSWORD']) {
        expect(traces).not.toContain(`${name}=`);
      }
    });

    it('writes no secret into the log', () => {
      const text = JSON.stringify(logs.lines());
      for (const v of secretValues) expect(text).not.toContain(v);
      expect(text).not.toContain(minioUrl);
      expect(text).not.toContain(bucket);
      expect(text).not.toContain(s.secretsDir);
      expect(text).not.toContain('pgpass');
    });

    it('a wrong restic password exits 78 and still deletes the dump', async () => {
      writeFileSync(join(s.secretsDir, 'restic_password'), `${rnd(24)}\n`);
      const { logger, lines } = memoryLogger('backup');
      const d = deps(s, { logger, pgDumpBin: pgDumpShim(s.shims, join(s.root, 'pg-env-2')), resticBin: resticBin });
      expect(await runBackup(runEnv, d)).toBe(78);
      expect(lines().at(-1)).toMatchObject({ msg: 'config_invalid', code: 'restic_password_rejected' });
      expect(readdirSync(s.stagingDir)).toEqual([]);
      expect(readdirSync(s.tmpDir)).toEqual([]);
      writeFileSync(join(s.secretsDir, 'restic_password'), `${resticPassword}\n`);
    });
  });
}
