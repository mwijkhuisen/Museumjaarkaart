import { type DbLogin, dbUrl } from '../src/db/migrate.ts';
import { insertHostileMuseum } from '../test/hostile-museum.ts';
import { seedCatalogue } from '../test/seed-catalogue.ts';

// CI e2e only (deploy/e2e): the catalogue seed plus the hostile museum, written as mjk_worker, mjk_api and
// mjk_migrator through their file secrets (/run/secrets/db_<login>, the host `db`). Prints counts only.

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
console.log(`seed-e2e: ${seeded.total} museums, ${seeded.visibleCount} visible, +1 hostile, list n=${seeded.list.n}`);
