import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// An applied migration is never edited (A§8): a changed, removed or new file
// fails here. A new migration adds its own line.
const PINNED: Record<string, string> = {
  '20261101000001_init.sql': '7972d5401bd3126b207979ed41864d7ec0579c9a215b1c7cb631060e6feab8a7',
  '20261102000001_museum_reference.sql': 'de6b1c0b5f844832f17769e9b428f8c7e761c2eca5b7c0df7cc25a73f926218d',
  '20261102000002_museums.sql': 'b09bb7fdff7b7f4f9f4eb952be0b70ff925b763e3e3b413d72ac6d1036ad9e24',
  '20261102000003_jobs.sql': '8a0b272158d6dddaf722bc23b6a4bff11768dd541e3366d41fa25ca738b1aef2',
  '20261103000001_search.sql': '55f72b998458728e4e511b0f6e23d5b211a97ad65399df3454d13788cb5a2d26',
  '20261103000002_public_views.sql': '53205ca0b792d16b49c45b0aed05de99eb2f5a981a0264eeb85743bedf9130ed',
  '20261127000001_accounts.sql': '3c296800f5a9d54a208f77479f58b31fe55a6e4f33435e200cd3c1711eafc99a',
  '20261127000002_actor_foreign_keys.sql': '537365e9300d29b5c7080d0b4a078959bd0e11aa7b703aa9425c865dc1f6e0c0',
  '20261128000001_passkeys.sql': '3859da99d97283c25e1f67259075572df69448b270f2668d1bf3fa7823074092', // gitleaks:allow (a sha256 pin)
  '20261128000002_passport.sql': 'e47659f0eaa982a83775854b6547efaa9a3478cc0b8467774896b8e07404ee94', // gitleaks:allow (a sha256 pin)
  '20261129000001_reviews.sql': 'ceef3623468b069ffad04fcf431b50488cab9d9bf55c470ad904a309ac4d3f58', // gitleaks:allow (a sha256 pin)
  '20261130000001_media.sql': 'adf302cb1162835f92a3268ace57e01456c1c4ac65922e0c2513a2d9a08d1866', // gitleaks:allow (a sha256 pin)
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
