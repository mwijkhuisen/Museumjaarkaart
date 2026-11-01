import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// An applied migration is never edited (A§8): a changed, removed or new file
// fails here. A new migration adds its own line.
const PINNED: Record<string, string> = {
  '20261101000001_init.sql': '7972d5401bd3126b207979ed41864d7ec0579c9a215b1c7cb631060e6feab8a7',
};

it('every migration matches its pinned sha256, and no file is added or removed', () => {
  const dir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
  const actual = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => [
        f,
        createHash('sha256')
          .update(readFileSync(dir + f))
          .digest('hex'),
      ]),
  );
  expect(actual).toEqual(PINNED);
});
