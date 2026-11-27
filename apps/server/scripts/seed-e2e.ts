import { TERMS_VERSION } from '@mjk/contracts';
import pg from 'pg';
import { createDb } from '../src/db/kysely.ts';
import { type DbLogin, dbUrl } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { recomputeStats } from '../src/reviews/stats-job.ts';
import { insertHostileMuseum } from '../test/hostile-museum.ts';
import { seedCatalogue } from '../test/seed-catalogue.ts';

/** Hostile to every HTML sink (invariant 5) and to markdown: a script close, markup, a link, a newline, an emoji. */
const HOSTILE_REVIEW_BODY = '</script><b>x</b> [x](y)\nTweede regel 🦊';

// CI e2e only (deploy/e2e): the catalogue seed plus the hostile museum, written as mjk_worker, mjk_api and
// mjk_migrator through their file secrets (/run/secrets/db_<login>, the host `db`). Prints counts only.
// P2a: also one owner account per engine (the emails in the Access stand-in's JWTs), each a plain `user` here:
// stack.sh makes owner_chromium `admin` and owner_webkit `moderator` through the production CLI (`admin user role`).
// P2c: one passport member per engine with two dated visits logged three days ago (a public visit log shows
// a visit only 24 hours after it is logged, A§10, so the passport spec cannot create those itself).
// One each, because a new code voids the last one and the two engines may sign in on the admin host at once.
// P3a (ratings and reviews), for the specs of the later work packages; every museum below is neither hostile,
// closed, hidden nor one of the passport members' two visited museums (the first two by id), and none is
// relied on for a fixed list position by an older spec (the default list is rank-ordered now: reviewed
// museums move, and the specs read their museums from the API or the page, never from a position):
//   - R1 (`seed.reviewed.hostile`): one review, rating 4, whose body is hostile text (`</script>`, markup, a
//     markdown link, a newline and an emoji: HOSTILE_REVIEW_BODY), by `seed_reviewer_1`.
//   - R2 (`seed.reviewed.rich`): three reviews (5, 4, 5; kid-friendly 5, 4, 4 so `kid_friendly=true` shows it),
//     by `seed_reviewer_1..3`; its score is the best, so it ranks first in the default list.
//   - R3 (`seed.reviewed.plain`): one review, rating 4, by `seed_reviewer_4`.
//   - Fold members `fold_<engine>` (email `fold-<engine>@mjk.test`, `hide_ratings_until_visited = true`): one
//     visit, to R2 (rated, visited: unfolds), none to R1 or R3 (rated, unvisited: stay folded).
//   - Reviewer members `reviewer_<engine>` (email `reviewer-<engine>@mjk.test`, current terms): one dated visit
//     (2026-09-12, logged three days ago) to R4 (`seed.prompt`, open, no review by anyone), for the prompt spec.
// P3b (photos, for photo-upload.spec.ts): two museums after R4, neither reviewed: P (`seed.photo`, photo_policy
// `allowed`) and PF (`seed.photo.forbidden`, `forbidden`: the form warns and still allows, owner Q4). Members
// `photo_<engine>` (stack.sh trusts them through the production `admin user trust`, so an attached photo is
// published), `photo_pending_<engine>` (untrusted: "wacht op controle") and `photo_bomb_<engine>` (the decompression
// bomb), emails `photo[-pending|-bomb]-<engine>@mjk.test`, each with a dated visit to P and PF.
//   - Last, one stats recompute as mjk_worker, called directly so no spec races the worker's job.
// The seed prints the slugs (`seed-e2e: reviewed hostile=… rich=… plain=… prompt=…`, `seed-e2e: photo plain=…
// forbidden=…`).

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
async function seedReviews(owner: pg.Client): Promise<void> {
  const rows = (
    await owner.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM museum WHERE NOT hidden AND closed_on IS NULL AND slug <> $1
        ORDER BY id OFFSET 2 LIMIT 4`,
      ['hostile-museum-zwolle'],
    )
  ).rows;
  const [r1, r2, r3, r4] = rows;
  if (r1 === undefined || r2 === undefined || r3 === undefined || r4 === undefined)
    throw new Error('seed-e2e: no museums');
  const user = async (handle: string, email: string, name: string, settings: object = {}): Promise<string> =>
    (
      await db
        .insertInto('app_user')
        .values({
          email,
          email_verified_at: new Date(),
          handle,
          display_name: name,
          age_confirmed_at: new Date(),
          terms_version: TERMS_VERSION,
          terms_accepted_at: new Date(),
          settings: JSON.stringify(settings),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  // created_at is the owner's: the visit is logged three days ago.
  const visit = async (userId: string, museumId: string, on: string): Promise<string> =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO visit (user_id, museum_id, visited_on, source, created_at)
         VALUES ($1, $2, $3, 'manual', now() - interval '3 days') RETURNING id`,
        [userId, museumId, on],
      )
    ).rows[0]?.id as string;
  const review = async (
    handle: string,
    museumId: string,
    rating: number,
    kid: number | null,
    body: string | null,
  ): Promise<void> => {
    const userId = await user(handle, `${handle}@mjk.test`, `E2E ${handle}`);
    const visitId = await visit(userId, museumId, '2026-09-12');
    await db
      .insertInto('review')
      .values({ user_id: userId, museum_id: museumId, visit_id: visitId, rating, kid_friendly: kid, body })
      .execute();
  };
  await review('seed_reviewer_1', r1.id, 4, null, HOSTILE_REVIEW_BODY);
  // R2's three reviews: seed_reviewer_1 also reviewed R1 above, so the same member rates two museums.
  const rev1 = (await owner.query<{ id: string }>('SELECT id FROM app_user WHERE handle = $1', ['seed_reviewer_1']))
    .rows[0];
  if (rev1 === undefined) throw new Error('seed-e2e: seed_reviewer_1');
  await db
    .insertInto('review')
    .values({
      user_id: rev1.id,
      museum_id: r2.id,
      visit_id: await visit(rev1.id, r2.id, '2026-10-03'),
      rating: 5,
      kid_friendly: 5,
      collection: 4,
      body: 'Prachtige collectie.',
    })
    .execute();
  await review('seed_reviewer_2', r2.id, 4, 4, 'Goed te doen met kinderen.');
  await review('seed_reviewer_3', r2.id, 5, 4, null);
  await review('seed_reviewer_4', r3.id, 4, null, 'Leuk voor een middag.');
  for (const engine of ['chromium', 'webkit'] as const) {
    const fold = await user(`fold_${engine}`, `fold-${engine}@mjk.test`, `E2E Fold ${engine}`, {
      hide_ratings_until_visited: true,
    });
    await visit(fold, r2.id, '2026-10-03');
    const reviewer = await user(`reviewer_${engine}`, `reviewer-${engine}@mjk.test`, `E2E Reviewer ${engine}`);
    await visit(reviewer, r4.id, '2026-09-12');
  }
  console.log(`seed-e2e: reviewed hostile=${r1.slug} rich=${r2.slug} plain=${r3.slug} prompt=${r4.slug}`);
  await seedPhotos(owner, user, visit, r4.id);
}

async function seedPhotos(
  owner: pg.Client,
  user: (handle: string, email: string, name: string) => Promise<string>,
  visit: (userId: string, museumId: string, on: string) => Promise<string>,
  after: string,
): Promise<void> {
  const rows = (
    await owner.query<{ id: string; slug: string; photo_policy: string }>(
      `SELECT DISTINCT ON (photo_policy) id, slug, photo_policy FROM museum
        WHERE NOT hidden AND closed_on IS NULL AND slug <> $1 AND id > $2 AND photo_policy IN ('allowed', 'forbidden')
        ORDER BY photo_policy, id`,
      ['hostile-museum-zwolle', after],
    )
  ).rows;
  const plain = rows.find((r) => r.photo_policy === 'allowed');
  const forbidden = rows.find((r) => r.photo_policy === 'forbidden');
  if (plain === undefined || forbidden === undefined) throw new Error('seed-e2e: no photo museums');
  for (const engine of ['chromium', 'webkit'] as const) {
    for (const [handle, email] of [
      [`photo_${engine}`, `photo-${engine}@mjk.test`],
      [`photo_pending_${engine}`, `photo-pending-${engine}@mjk.test`],
      // The decompression bomb's uploader: a member of its own, so no spec signs one address in twice.
      [`photo_bomb_${engine}`, `photo-bomb-${engine}@mjk.test`],
    ] as const) {
      const id = await user(handle, email, `E2E ${handle}`);
      await visit(id, plain.id, '2026-09-12');
      await visit(id, forbidden.id, '2026-10-03');
    }
  }
  console.log(`seed-e2e: photo plain=${plain.slug} forbidden=${forbidden.slug}`);
}

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
    await seedReviews(owner);
  } finally {
    await owner.end();
  }
} finally {
  await db.destroy();
}
const worker = createPool('mjk_worker', { DATABASE_URL: urls.mjk_worker }, { max: 1 });
if (typeof worker === 'string') throw new Error(`seed-e2e: ${worker}`);
const workerDb = createDb(worker);
try {
  await recomputeStats(workerDb);
} finally {
  await workerDb.destroy();
}
console.log(`seed-e2e: ${seeded.total} museums, ${seeded.visibleCount} visible, +1 hostile, list n=${seeded.list.n}`);
