import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// An applied migration is never edited (A§8): a changed, removed or new file
// fails here. A new migration adds its own line.
const PINNED: Record<string, string> = {
  '20261101000001_init.sql': '7972d5401bd3126b207979ed41864d7ec0579c9a215b1c7cb631060e6feab8a7',
  '20261102000001_museum_reference.sql': 'de6b1c0b5f844832f17769e9b428f8c7e761c2eca5b7c0df7cc25a73f926218d',
  '20261102000002_museums.sql': 'd35f258bbf225777422d9178c35b73b56e0ce211d90c3e4fdb70930254c4c137',
  '20261102000003_jobs.sql': '8a0b272158d6dddaf722bc23b6a4bff11768dd541e3366d41fa25ca738b1aef2',
  '20261103000001_search.sql': 'cc0054e9c1a71d2ffe295e323b71bfff07f6f5c3dbd6b3d0a774de629a8d3865',
  '20261103000002_public_views.sql': '064b5e38fc6dbc67c0c3a6b95168b6e710707f4a17429339c673267aab71290b',
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
