import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_TABLE_DATA,
  parseBackupConfig,
  pgDumpArgs,
  pgDumpEnv,
  pgpassLine,
  RESTIC_HOST,
  resticBackupArgs,
  resticEnv,
} from '../../src/backup/plan.ts';

const EP = 'https://0123456789abcdef.eu.r2.cloudflarestorage.com';

describe('the exclusion list', () => {
  it('is exactly the A§17.6 tables', () => {
    expect([...EXCLUDED_TABLE_DATA]).toEqual(['session', 'email_code', 'auth_challenge', 'rate_limit', 'job']);
  });

  it('pg_dump gets one --exclude-table-data per table, schema-qualified, and never --strict-names', () => {
    const args = pgDumpArgs('/srv/mjk/backup-staging/mjk.dump');
    expect(args.filter((a) => a.startsWith('--exclude-table-data='))).toEqual(
      EXCLUDED_TABLE_DATA.map((t) => `--exclude-table-data=public.${t}`),
    );
    expect(args).not.toContain('--strict-names');
    expect(args).toContain('--format=custom');
    expect(args).toContain('--file=/srv/mjk/backup-staging/mjk.dump');
    expect(args).toContain('--no-password');
  });

  it('puts no password and no connection string in the arguments', () => {
    expect(pgDumpArgs('/x/mjk.dump').join(' ')).not.toMatch(/postgres(ql)?:|password=|dbname=/i);
  });
});

describe('pgpass and the pg_dump environment', () => {
  const url = new URL('postgres://mjk_backup:s3cr3t_pw-ABCDEFGHIJKLMNOPQRSTUV@db:5432/mjk?sslmode=disable');

  it('writes host:port:database:user:password', () => {
    expect(pgpassLine(url)).toBe('db:5432:mjk:mjk_backup:s3cr3t_pw-ABCDEFGHIJKLMNOPQRSTUV\n');
  });

  it('escapes a colon and a backslash, and decodes percent escapes', () => {
    const odd = new URL('postgres://u%3Ax:p%5Cw%3Ad@h:6543/d');
    expect(pgpassLine(odd)).toBe('h:6543:d:u\\:x:p\\\\w\\:d\n');
  });

  it('names the connection through PG* variables, with the pgpass path and no password', () => {
    const env = pgDumpEnv(url, '/tmp/mjk-backup-x/pgpass');
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      PGHOST: 'db',
      PGPORT: '5432',
      PGUSER: 'mjk_backup',
      PGDATABASE: 'mjk',
      PGPASSFILE: '/tmp/mjk-backup-x/pgpass',
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'mjk_backup',
      PGSSLMODE: 'disable',
    });
    expect(JSON.stringify(env)).not.toContain('s3cr3t');
  });

  it('ignores an unknown sslmode and takes a conninfo-looking database name as a plain name', () => {
    const env = pgDumpEnv(new URL('postgres://u:p@h/a%3Db?sslmode=bogus'), '/p');
    expect(env.PGDATABASE).toBe('a=b');
    expect(env).not.toHaveProperty('PGSSLMODE');
  });
});

describe('restic', () => {
  it('builds the repository and the environment from names and paths only', () => {
    const parsed = parseBackupConfig({ MJK_R2_ENDPOINT: EP, MJK_R2_BUCKET_BACKUP: 'mjk-backup' });
    expect(parsed).toEqual({
      ok: true,
      config: { repository: `s3:${EP}/mjk-backup`, region: 'auto' },
    });
    if (!parsed.ok) throw new Error('unreachable');
    expect(resticEnv(parsed.config)).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp',
      TMPDIR: '/tmp',
      XDG_CACHE_HOME: '/tmp/.cache',
      RESTIC_REPOSITORY: `s3:${EP}/mjk-backup`,
      RESTIC_PASSWORD_FILE: '/run/secrets/restic_password',
      AWS_SHARED_CREDENTIALS_FILE: '/run/secrets/r2_backup_put',
      AWS_DEFAULT_REGION: 'auto',
    });
  });

  it('backs up the dump and the originals with no cache, a fixed host and no forget or prune', () => {
    const args = resticBackupArgs(['/srv/mjk/backup-staging/mjk.dump', '/srv/mjk/originals']);
    expect(args).toEqual([
      '--no-cache',
      '--quiet',
      '--json',
      'backup',
      '--host',
      RESTIC_HOST,
      '--tag',
      'nightly',
      '--',
      '/srv/mjk/backup-staging/mjk.dump',
      '/srv/mjk/originals',
    ]);
    expect(args.join(' ')).not.toMatch(/forget|prune/);
  });

  it('accepts plain http only for loopback (the MinIO stand-in) and takes a region from MJK_R2_REGION', () => {
    expect(
      parseBackupConfig({
        MJK_R2_ENDPOINT: 'http://127.0.0.1:59000',
        MJK_R2_BUCKET_BACKUP: 'bkt1',
        MJK_R2_REGION: 'us-east-1',
      }),
    ).toEqual({
      ok: true,
      config: { repository: 's3:http://127.0.0.1:59000/bkt1', region: 'us-east-1' },
    });
  });

  it.each([
    [{}, 'config_missing'],
    [{ MJK_R2_ENDPOINT: EP }, 'config_missing'],
    [{ MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'config_missing'],
    [{ MJK_R2_ENDPOINT: 'not a url', MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'http://example.invalid', MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'ftp://127.0.0.1', MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: 'https://key:secret@host.example', MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: `${EP}/extra`, MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: `${EP}?x=1`, MJK_R2_BUCKET_BACKUP: 'mjk-backup' }, 'endpoint_invalid'],
    [{ MJK_R2_ENDPOINT: EP, MJK_R2_BUCKET_BACKUP: 'Bad_Bucket' }, 'bucket_invalid'],
    [{ MJK_R2_ENDPOINT: EP, MJK_R2_BUCKET_BACKUP: 'a..b' }, 'bucket_invalid'],
    [{ MJK_R2_ENDPOINT: EP, MJK_R2_BUCKET_BACKUP: '-rf' }, 'bucket_invalid'],
    [{ MJK_R2_ENDPOINT: EP, MJK_R2_BUCKET_BACKUP: 'mjk-backup', MJK_R2_REGION: 'a b' }, 'region_invalid'],
  ])('refuses %j with %s', (env, code) => {
    expect(parseBackupConfig(env)).toEqual({ ok: false, code });
  });
});
