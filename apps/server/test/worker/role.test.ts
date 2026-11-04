import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { memoryLogger } from '../../src/lib/log.ts';
import { runWorkerRole } from '../../src/worker/role.ts';

it('exits 78 and logs only config_invalid when the database URL cannot be built', async () => {
  const { logger, lines } = memoryLogger('worker');
  // No DATABASE_URL and no /run/secrets/db_mjk_worker in the sandbox; the bad URL must not be echoed.
  const code = await runWorkerRole(
    { DATABASE_URL: 'http://secret-host.invalid/not-postgres' },
    {
      handlers: {},
      logger,
      signal: new AbortController().signal,
      heartbeatPath: join(mkdtempSync(join(tmpdir(), 'mjk-role-')), 'hb'),
    },
  );
  expect(code).toBe(78);
  expect(lines().map((l) => l.msg)).toEqual(['config_invalid']);
  expect(JSON.stringify(lines())).not.toContain('secret-host');
});
