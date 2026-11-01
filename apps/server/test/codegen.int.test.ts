import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from './db.ts';

// src/db/types.ts is generated (`pnpm --filter @mjk/server db:types`). This runs
// kysely-codegen with the same flags plus --verify against a freshly migrated
// database: it exits non-zero when the committed file is stale. This replaces a
// CI workflow step (no change under .github/).

const exec = promisify(execFile);
const SERVER = fileURLToPath(new URL('..', import.meta.url));
const CODEGEN = fileURLToPath(new URL('../node_modules/kysely-codegen/dist/cli/bin.js', import.meta.url));

let db: TestDb;
beforeAll(async () => {
  db = await createMigratedDb();
});
afterAll(() => db.drop());

/** The flags of the `db:types` script, so the test cannot drift from it. */
function dbTypesFlags(): string[] {
  const script = (JSON.parse(readFileSync(`${SERVER}package.json`, 'utf8')) as { scripts: Record<string, string> })
    .scripts['db:types'];
  const prefix = 'kysely-codegen ';
  expect(script?.startsWith(prefix)).toBe(true);
  return (script as string).slice(prefix.length).split(/\s+/);
}

it('src/db/types.ts is what kysely-codegen generates from the migrated schema', { timeout: 60_000 }, async () => {
  const flags = dbTypesFlags();
  expect(flags).toContain('--date-parser'); // dates are strings, like the pool's type parser
  const env = { PATH: process.env.PATH, DATABASE_URL: db.urls.mjk_migrator };
  await expect(exec(process.execPath, [CODEGEN, ...flags, '--verify'], { cwd: SERVER, env })).resolves.toBeDefined();
});
