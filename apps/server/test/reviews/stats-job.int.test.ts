import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BAYES_C, bayes } from '../../src/reviews/score.ts';
import { recomputeStats, STATS_RECOMPUTE_JOB, statsRecomputeJob } from '../../src/reviews/stats-job.ts';
import { enqueueStats } from '../../src/reviews/stats-queue.ts';
import { claim, fail, LEASE_SECONDS } from '../../src/worker/queue.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { addReview } from './fixtures.ts';

// P3a WP4: the `stats_recompute` job. What it counts, and that no committed change is lost between the
// queue's unique index and the advisory lock (stats-queue.ts).

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(() => p?.close());
beforeEach(async () => {
  await p.owner.query('DELETE FROM job');
});

const stats = async (museumId: string) =>
  (await p.owner.query('SELECT * FROM museum_stats WHERE museum_id = $1', [museumId])).rows[0];
const jobs = async () =>
  (await p.owner.query<{ state: string; max_attempts: number }>('SELECT state, max_attempts FROM job ORDER BY id'))
    .rows;

/** Queues the job on its own committed transaction, as a writer would. */
const queue = () => p.db.transaction().execute((trx) => enqueueStats(trx));

describe('what the recompute counts', () => {
  it('counts visible reviews of non-hidden museums by authors who are not deleted, detached ones included', async () => {
    const x = await p.visible(0);
    const mk = async (status: string, rating: number, collection: number | null) => {
      const u = await p.newMember({ status });
      const visitId = await p.addVisit(u.id, x.id);
      const reviewId = await addReview(p, { userId: u.id, museumId: x.id, visitId, rating, collection });
      return { u, reviewId };
    };
    await mk('active', 5, 4);
    await mk('banned', 3, 4); // a banned author's review counts
    await mk('deleted', 1, 1); // a deleted author's does not
    const removed = await mk('active', 1, 2);
    await p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [removed.reviewId]);
    const detached = await mk('active', 4, 4); // D10's detach: no author, no visit
    await p.owner.query(
      `UPDATE review SET user_id = NULL, visit_id = NULL, former_member = true, former_visited_on = '2026-01-02'
        WHERE id = $1`,
      [detached.reviewId],
    );
    // a review on a hidden museum counts for neither the museum nor m
    const h = await p.hidden();
    const hu = await p.newMember();
    await addReview(p, { userId: hu.id, museumId: h.id, visitId: await p.addVisit(hu.id, h.id), rating: 1 });

    await recomputeStats(p.worker);

    const s = await stats(x.id);
    expect(s.rating_count).toBe(3);
    expect(s.rating_mean).toBe(4); // (5 + 3 + 4) / 3
    expect(s.collection_count).toBe(3);
    expect(s.collection_mean).toBe(4);
    expect(s.presentation_count).toBe(0);
    expect(s.presentation_mean).toBeNull();
    expect(s.visit_count).toBe(5); // every visit counts, whatever became of its review
    // A museum no one visited counts 0 (the grouped visit count is joined in, not correlated).
    expect((await stats((await p.visible(2)).id)).visit_count).toBe(0);
    expect(Math.abs(s.bayes_score - bayes(BAYES_C, 4, [5, 3, 4]))).toBeLessThan(1e-9);

    const hs = await stats(h.id);
    expect(hs.rating_count).toBe(0);
    expect(hs.rating_mean).toBeNull();
    expect(Math.abs(hs.bayes_score - 4)).toBeLessThan(1e-9); // m is 4: the hidden museum's 1 is not in it
    // the public view leaves a hidden museum out and shows no visit_count
    expect((await p.pools.ssr.query('SELECT 1 FROM pub_museum_stats WHERE museum_id = $1', [h.id])).rows).toEqual([]);
    expect(
      (await p.pools.ssr.query('SELECT * FROM pub_museum_stats WHERE museum_id = $1', [x.id])).fields.map(
        (f) => f.name,
      ),
    ).not.toContain('visit_count');
  }, 120_000);

  it('is idempotent and writes one row per museum', async () => {
    const first = await recomputeStats(p.worker);
    const again = await recomputeStats(p.worker);
    expect(first).toBe(p.catalogue.total);
    expect(again).toBe(first);
    const n = await p.owner.query<{ n: string }>('SELECT count(*) AS n FROM museum_stats');
    expect(Number(n.rows[0]?.n)).toBe(p.catalogue.total);
  });
});

describe('the queue', () => {
  it('queues one job at a time, and a new one after a claim', async () => {
    await queue();
    await queue();
    expect(await jobs()).toEqual([{ state: 'queued', max_attempts: 1 }]);
    const job = await claim(p.worker, 'w1', { leaseSeconds: LEASE_SECONDS });
    expect(job?.kind).toBe(STATS_RECOMPUTE_JOB);
    await queue();
    await queue();
    expect((await jobs()).map((j) => j.state)).toEqual(['running', 'queued']);
  });

  it('a failed run is not retried, and the next change queues a fresh job', async () => {
    await queue();
    const job = await claim(p.worker, 'w1', { leaseSeconds: LEASE_SECONDS });
    if (job === undefined) throw new Error('no job');
    expect(await fail(p.worker, job, 'w1', 'internal', true)).toBe('failed');
    expect(await claim(p.worker, 'w1', { leaseSeconds: LEASE_SECONDS })).toBeUndefined();
    await queue();
    expect((await jobs()).map((j) => j.state)).toEqual(['failed', 'queued']);
  });
});

describe('no change is lost', () => {
  /** Waits until some session waits for an advisory lock. */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = await p.owner.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
      if (r.rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the handler never waited for the lock');
  }

  it('a writer that skipped its insert because a job was queued is read by that job', async () => {
    const m = await p.visible(1);
    const u = await p.newMember();
    const visitId = await p.addVisit(u.id, m.id);
    await recomputeStats(p.worker);
    expect((await stats(m.id)).rating_count).toBe(0);

    await queue(); // job J is queued
    const b = await p.db.startTransaction().execute(); // writer B
    await sql`INSERT INTO review (user_id, museum_id, visit_id, rating)
              VALUES (${u.id}::uuid, ${m.id}::uuid, ${visitId}::uuid, 5)`.execute(b);
    await enqueueStats(b); // J is queued: B's insert conflicts, B holds the shared lock until it commits
    expect(await jobs()).toEqual([{ state: 'queued', max_attempts: 1 }]);

    const job = await claim(p.worker, 'w1', { leaseSeconds: LEASE_SECONDS }); // the worker claims J ...
    expect(job).toBeDefined();
    let done = false;
    const run = statsRecomputeJob(p.worker)({}, { signal: new AbortController().signal }).then(() => {
      done = true;
    });
    await waitForLockWait(); // ... and its handler waits for B
    expect(done).toBe(false);
    expect((await stats(m.id)).rating_count).toBe(0);

    await b.commit().execute();
    await run;
    expect((await stats(m.id)).rating_count).toBe(1); // B's rating is in the result
    expect((await stats(m.id)).rating_mean).toBe(5);
  }, 60_000);

  it('a writer that arrives after the claim queues the next job', async () => {
    await queue();
    await claim(p.worker, 'w1', { leaseSeconds: LEASE_SECONDS });
    await queue(); // after the claim: no queued job, so it inserts one
    expect((await jobs()).map((j) => j.state)).toEqual(['running', 'queued']);
  });
});
