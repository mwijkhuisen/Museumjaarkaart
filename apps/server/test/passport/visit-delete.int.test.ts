import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberWithVisit, openMuseum, reviewsApp } from '../reviews/app.ts';
import { addReview } from '../reviews/fixtures.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P3a WP3 (criterion 6): a visit that a review cites cannot be deleted. The 409 is decided in SQL, so the normal
// flow raises no database error; the foreign key (review_cites_own_visit, ON DELETE RESTRICT) is the backstop.
// The PostgreSQL server log (PG_LOG_CONTAINER, as pg-log.int.test.ts) proves "no ERROR line for this visit"; it is skipped
// locally when the variable is unset and required under CI.

let p: PassportDb;
let t: ReturnType<typeof reviewsApp>;
beforeAll(async () => {
  p = await openPassportDb();
  t = reviewsApp(p);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const exec = promisify(execFile);
const container = process.env.PG_LOG_CONTAINER;
const dockerLog = async (): Promise<string> => {
  const { stdout, stderr } = await exec('docker', ['logs', String(container)], { maxBuffer: 256 * 1024 * 1024 });
  return `${stdout}\n${stderr}`;
};
const settle = () => new Promise((r) => setTimeout(r, 400));

let nth = 0;
const scene = async () => {
  const m = await openMuseum(p, 600 + nth++);
  const me = await memberWithVisit(p, t, m.id);
  const reviewId = await addReview(p, { userId: me.id, museumId: m.id, visitId: me.visitId, rating: 4 });
  return { m, me, reviewId };
};
const del = (token: string, id: string) => t.call(`/me/visits/${id}`, { method: 'DELETE', token });

describe('DELETE /me/visits/:id with a review', () => {
  it('a cited visit is a 409 and stays; after the review is deleted it is a 204', async () => {
    const { me, reviewId } = await scene();
    const r = await del(me.token, me.visitId);
    expect([r.status, await r.json()]).toEqual([409, { error: 'conflict' }]);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await p.admin.query('SELECT 1 FROM visit WHERE id = $1', [me.visitId])).rowCount).toBe(1);
    expect((await p.admin.query('SELECT 1 FROM review WHERE id = $1', [reviewId])).rowCount).toBe(1);

    expect((await t.call(`/reviews/${reviewId}`, { method: 'DELETE', token: me.token })).status).toBe(204);
    expect((await del(me.token, me.visitId)).status).toBe(204);
    expect((await p.admin.query('SELECT 1 FROM visit WHERE id = $1', [me.visitId])).rowCount).toBe(0);
    // Gone now: the same call is a 404.
    expect((await del(me.token, me.visitId)).status).toBe(404);
  });

  it('a visit the review does not cite goes, even to the same museum; the cited one stays', async () => {
    const { m, me } = await scene();
    const other = await p.addVisit(me.id, m.id, { on: '2026-01-01' });
    expect((await del(me.token, other)).status).toBe(204);
    expect((await del(me.token, me.visitId)).status).toBe(409);
  });

  it('after the review cites another visit, the first one can go and the new one is a 409', async () => {
    const { m, me, reviewId } = await scene();
    const other = await p.addVisit(me.id, m.id, { on: '2026-01-01' });
    expect(
      (await t.call(`/reviews/${reviewId}`, { method: 'PATCH', token: me.token, body: { visit_id: other } })).status,
    ).toBe(200);
    expect((await del(me.token, me.visitId)).status).toBe(204);
    expect((await del(me.token, other)).status).toBe(409);
  });

  it("another member's visit is a 404 (never a 409: it must not say the visit is cited), and survives", async () => {
    const { me } = await scene();
    const stranger = await p.newMember();
    const token = await t.signIn(stranger.id);
    const r = await del(token, me.visitId);
    expect([r.status, await r.json()]).toEqual([404, { error: 'not_found' }]);
    expect((await p.admin.query('SELECT 1 FROM visit WHERE id = $1', [me.visitId])).rowCount).toBe(1);
    expect((await del(token, '00000000-0000-4000-8000-000000000006')).status).toBe(404);
    expect((await del(me.token, 'not-a-uuid')).status).toBe(400);
    expect((await t.call(`/me/visits/${me.visitId}`, { method: 'DELETE' })).status).toBe(401);
  });

  it('an account delete still cascades through the cited visit and the review', async () => {
    const { me, reviewId } = await scene();
    await p.admin.query('DELETE FROM app_user WHERE id = $1', [me.id]);
    expect((await p.admin.query('SELECT 1 FROM review WHERE id = $1', [reviewId])).rowCount).toBe(0);
    expect((await p.admin.query('SELECT 1 FROM visit WHERE id = $1', [me.visitId])).rowCount).toBe(0);
  });
});

if (container === undefined || container === '') {
  if (process.env.CI) {
    it('PG_LOG_CONTAINER is set in CI', () => {
      expect.fail('PG_LOG_CONTAINER must name the PostgreSQL container in CI');
    });
  } else {
    it.skip('the 409 raises no PostgreSQL ERROR (skipped: PG_LOG_CONTAINER is not set)', () => {});
  }
} else {
  describe('the PostgreSQL log', () => {
    it('gains no ERROR line from the 409 path, while the foreign key itself would (the capture works)', async () => {
      const { me } = await scene();
      const before = (await dockerLog()).length;
      for (let i = 0; i < 3; i++) expect((await del(me.token, me.visitId)).status).toBe(409);
      await settle();
      const normal = (await dockerLog()).slice(before);
      // The foreign key's error would quote this visit's id (DETAIL: Key (...) is still referenced). Other test
      // files share the cluster and may log their own errors, so the marker is the id, not the word ERROR.
      expect(normal).not.toContain(me.visitId);

      // The backstop: the same delete without the NOT EXISTS, straight at the table, is the foreign key's error.
      const mark = (await dockerLog()).length;
      await expect(p.pools.api.query('DELETE FROM visit WHERE id = $1', [me.visitId])).rejects.toMatchObject({
        code: '23001',
        constraint: 'review_cites_own_visit',
      });
      await settle();
      expect((await dockerLog()).slice(mark)).toContain(me.visitId);
    });
  });
}
