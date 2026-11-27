import { TERMS_VERSION } from '@mjk/contracts';
import pg from 'pg';
import { createDb } from '../src/db/kysely.ts';
import { type DbLogin, dbUrl } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { insertHostileMuseum } from '../test/hostile-museum.ts';
import { seedCatalogue } from '../test/seed-catalogue.ts';

// CI e2e only (deploy/e2e): the catalogue seed plus the hostile museum, written as mjk_worker, mjk_api and
// mjk_migrator through their file secrets (/run/secrets/db_<login>, the host `db`). Prints counts only.
// P2a: also one owner account per engine (the emails in the Access stand-in's JWTs), each a plain `user` here:
// stack.sh makes owner_chromium `admin` and owner_webkit `moderator` through the production CLI (`admin user role`).
// P2c: one passport member per engine with two dated visits logged three days ago (a public visit log shows
// a visit only 24 hours after it is logged, A§10, so the passport spec cannot create those itself).
// One each, because a new code voids the last one and the two engines may sign in on the admin host at once.

const urls = {} as Record<DbLogin | 'admin', string>;
for (const login of ['mjk_worker', 'mjk_api', 'mjk_migrator'] as const) {
  const url = dbUrl(login, {});
  // The text never holds the secret, only its name.
  if (typeof url === 'string') {
    console.error(`seed-e2e: ${url}`);
    process.exit(78);
  }
  urls[login] = url.href;
}
urls.admin = ''; // no superuser here, and seedCatalogue does not use it

const seeded = await seedCatalogue({ urls, drop: async () => {} });
await insertHostileMuseum(urls.mjk_api);
const pool = createPool('mjk_api', { DATABASE_URL: urls.mjk_api }, { max: 1 });
if (typeof pool === 'string') throw new Error(`seed-e2e: ${pool}`);
const db = createDb(pool);
try {
  const now = new Date();
  await db
    .insertInto('app_user')
    .values(
      (['chromium', 'webkit'] as const).map((engine) => ({
        email: `owner-${engine}@mjk.test`,
        email_verified_at: now,
        handle: `owner_${engine}`,
        display_name: `E2E Owner ${engine}`,
        age_confirmed_at: now,
        terms_version: TERMS_VERSION,
        terms_accepted_at: now,
      })),
    )
    .execute();
  const passport = await db
    .insertInto('app_user')
    .values(
      (['chromium', 'webkit'] as const).map((engine) => ({
        email: `passport-${engine}@mjk.test`,
        email_verified_at: now,
        handle: `passport_${engine}`,
        display_name: `E2E Passport ${engine}`,
        age_confirmed_at: now,
        terms_version: TERMS_VERSION,
        terms_accepted_at: now,
      })),
    )
    .returning('id')
    .execute();
  // created_at is not the api's to write: the table's owner backdates the visits.
  const owner = new pg.Client({ connectionString: urls.mjk_migrator });
  await owner.connect();
  try {
    const museums = (
      await owner.query<{ id: string }>('SELECT id FROM museum WHERE NOT hidden AND slug <> $1 ORDER BY id LIMIT 2', [
        'hostile-museum-zwolle',
      ])
    ).rows;
    for (const { id: userId } of passport)
      for (const [i, museum] of museums.entries())
        await owner.query(
          `INSERT INTO visit (user_id, museum_id, visited_on, source, created_at) VALUES ($1, $2, $3, 'manual', now() - interval '3 days')`,
          [userId, museum.id, ['2026-09-12', '2026-10-03'][i]],
        );
  } finally {
    await owner.end();
  }
} finally {
  await db.destroy();
}
console.log(`seed-e2e: ${seeded.total} museums, ${seeded.visibleCount} visible, +1 hostile, list n=${seeded.list.n}`);
