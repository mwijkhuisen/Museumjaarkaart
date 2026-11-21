import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBackup, summaryOf } from '../../src/backup/run.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { run } from '../../src/main.ts';

// The role's refusals, which need no database or restic: config problems exit 78, an
// unreachable database exits 69. The full run is in run.int.test.ts.

const dir = () => mkdtempSync(join(tmpdir(), 'mjk-bk-'));
const GOOD = { MJK_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com', MJK_R2_BUCKET_BACKUP: 'mjk-backup' };
// Port 1 refuses at once.
const DEAD_DB = 'postgres://mjk_backup:pw-pw-pw-pw-pw-pw-pw-pw-pw@127.0.0.1:1/mjk';

function layout() {
  const root = dir();
  const secretsDir = join(root, 'secrets');
  const stagingDir = join(root, 'staging');
  const originalsDir = join(root, 'originals');
  for (const d of [secretsDir, stagingDir, originalsDir]) mkdirSync(d);
  writeFileSync(join(secretsDir, 'restic_password'), 'x\n');
  writeFileSync(join(secretsDir, 'r2_backup_put'), '[default]\n');
  return { root, secretsDir, stagingDir, originalsDir, tmpDir: dir() };
}

describe('config errors exit 78 with a fixed code', () => {
  it('no endpoint or bucket', async () => {
    const { logger, lines } = memoryLogger('backup');
    const { root: _root, ...deps } = layout();
    expect(await runBackup({ DATABASE_URL: DEAD_DB }, { logger, ...deps })).toBe(78);
    expect(lines()).toMatchObject([{ msg: 'config_invalid', code: 'config_missing' }]);
  });

  it('no database secret', async () => {
    const { logger, lines } = memoryLogger('backup');
    const { root: _root, ...deps } = layout();
    expect(await runBackup(GOOD, { logger, ...deps })).toBe(78);
    expect(lines()).toMatchObject([{ msg: 'config_invalid', code: 'database_config' }]);
  });

  it.each(['restic_password', 'r2_backup_put'])('an empty %s file', async (name) => {
    const { logger, lines } = memoryLogger('backup');
    const { root: _root, ...deps } = layout();
    writeFileSync(join(deps.secretsDir, name), '');
    expect(await runBackup({ ...GOOD, DATABASE_URL: DEAD_DB }, { logger, ...deps })).toBe(78);
    expect(lines()).toMatchObject([{ msg: 'config_invalid', code: `secret_${name}` }]);
  });

  it('a missing staging directory or originals directory', async () => {
    const { root, ...deps } = layout();
    const env = { ...GOOD, DATABASE_URL: DEAD_DB };
    const a = memoryLogger('backup');
    expect(await runBackup(env, { logger: a.logger, ...deps, stagingDir: join(root, 'nope') })).toBe(78);
    expect(a.lines()).toMatchObject([{ code: 'staging_missing' }]);
    const b = memoryLogger('backup');
    expect(await runBackup(env, { logger: b.logger, ...deps, originalsDir: join(root, 'nope') })).toBe(78);
    expect(b.lines()).toMatchObject([{ code: 'originals_missing' }]);
  });
});

describe('an unreachable database', () => {
  it('exits 69, leaves nothing behind and starts no child', async () => {
    const { logger, lines } = memoryLogger('backup');
    const { root, ...deps } = layout();
    // A binary that would leave a trace if it ran.
    const trap = join(root, 'trap');
    writeFileSync(trap, `#!/bin/sh\ntouch ${join(root, 'ran')}\n`);
    chmodSync(trap, 0o755);
    expect(
      await runBackup({ ...GOOD, DATABASE_URL: DEAD_DB }, { logger, ...deps, pgDumpBin: trap, resticBin: trap }),
    ).toBe(69);
    expect(lines().map((x) => x.msg)).toEqual(['backup_started', 'db_unavailable']);
    expect(existsSync(join(root, 'ran'))).toBe(false);
    expect(readdirSync(deps.stagingDir)).toEqual([]);
    expect(readdirSync(deps.tmpDir)).toEqual([]);
    expect(JSON.stringify(lines())).not.toContain('pw-pw');
  });
});

describe('main.ts', () => {
  it('wires the role: its paths and binaries come from deps.backup', async () => {
    const { root: _root, ...deps } = layout();
    const code = await run(['backup'], { ...GOOD, DATABASE_URL: DEAD_DB }, () => {}, undefined, {
      signal: new AbortController().signal,
      backup: { logger: memoryLogger('backup').logger, ...deps },
    });
    expect(code).toBe(69);
  });
});

describe('summaryOf', () => {
  it('reads the snapshot id from the last summary line', () => {
    const out = [
      '{"message_type":"error","error":{"message":"x"}}',
      '{"message_type":"summary","files_new":3,"snapshot_id":"0123456789abcdef0123456789abcdef"}',
      '',
    ].join('\n');
    expect(summaryOf(out)).toEqual({ snapshot: '01234567', filesNew: 3 });
  });

  it.each([[''], ['not json'], ['{"message_type":"summary","snapshot_id":"zz"}'], ['{"a":']])(
    '%j has no summary',
    (out) => {
      expect(summaryOf(out)).toBeUndefined();
    },
  );
});
