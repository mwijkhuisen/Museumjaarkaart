import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { mediaPublishJob } from '../../src/media/publish.ts';
import type { R2Client } from '../../src/media/r2.ts';
import { markRemoved, mediaDeleteJob } from '../../src/media/remove.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { dropBucket, listKeys, minioBucket, minioUrl, pendingPhoto } from './pending.ts';

// A§12 "Removal": markRemoved (the api's half, in the caller's transaction) and the worker's `media_delete`:
// the R2 keys, the quarantine copies, the original and the row. A photo that never reached R2 is deleted
// without R2's config; the R2 part runs on the MinIO stand-in (skipped locally without it, a failure under CI).

let p: PassportDb;
let quarantine: string;
let originals: string;
const signal = new AbortController().signal;

beforeAll(async () => {
  p = await openPassportDb();
  quarantine = await mkdtemp(join(tmpdir(), 'mjk-q-'));
  originals = await mkdtemp(join(tmpdir(), 'mjk-orig-'));
}, 180_000);
afterAll(async () => {
  await p?.close();
  for (const d of [quarantine, originals]) if (d !== undefined) await rm(d, { recursive: true, force: true });
});

const del = (id: string, r2?: R2Client) =>
  mediaDeleteJob({
    db: p.worker,
    env: {},
    quarantineDir: quarantine,
    originalsDir: originals,
    ...(r2 === undefined ? {} : { r2 }),
  })({ media_id: id }, { signal });
const row = async (id: string) =>
  (await p.owner.query<{ state: string }>('SELECT state FROM media WHERE id = $1', [id])).rows[0];
const variants = async (id: string) =>
  Number((await p.owner.query('SELECT count(*) AS n FROM media_variant WHERE media_id = $1', [id])).rows[0].n);
const deleteJobs = async (id: string) =>
  Number(
    (
      await p.owner.query(`SELECT count(*) AS n FROM job WHERE kind = 'media_delete' AND payload->>'media_id' = $1`, [
        id,
      ])
    ).rows[0].n,
  );

it('markRemoved marks live photos removed and queues one media_delete each; removed and failed are left', async () => {
  const live = await pendingPhoto(p, quarantine, { trusted: false });
  const failed = await pendingPhoto(p, quarantine, { trusted: false });
  await p.owner.query(`UPDATE media SET state = 'failed', error_code = 'x' WHERE id = $1`, [failed.id]);
  const marked = await p.db.transaction().execute((trx) => markRemoved(trx, [live.id, failed.id]));
  expect(marked).toEqual([live.id]);
  expect((await row(live.id))?.state).toBe('removed');
  expect((await row(failed.id))?.state).toBe('failed');
  expect(await deleteJobs(live.id)).toBe(1);
  expect(await deleteJobs(failed.id)).toBe(0);
  // A second call marks nothing and queues nothing more.
  expect(await p.db.transaction().execute((trx) => markRemoved(trx, [live.id]))).toEqual([]);
  expect(await deleteJobs(live.id)).toBe(1);
});

it('deletes a never-published photo without R2: its quarantine copies, a stray original, the row and its variants', async () => {
  const ph = await pendingPhoto(p, quarantine, { trusted: false });
  await writeFile(join(originals, `${ph.id}.tmp`), 'stray');
  await p.db.transaction().execute((trx) => markRemoved(trx, [ph.id]));
  // No r2 seam and no MJK_R2_* config: a client would throw store_endpoint_invalid.
  await del(ph.id);
  expect(await row(ph.id)).toBeUndefined();
  expect(await variants(ph.id)).toBe(0);
  expect(existsSync(join(quarantine, ph.id))).toBe(false);
  expect(existsSync(join(originals, `${ph.id}.tmp`))).toBe(false);
  // Idempotent: the row is gone, a retry is fine.
  await del(ph.id);
});

it('leaves a photo that is not removed alone, and needs R2 once a publish job ran for it', async () => {
  const ph = await pendingPhoto(p, quarantine, { trusted: false });
  await del(ph.id);
  expect((await row(ph.id))?.state).toBe('pending_review');
  expect(existsSync(join(quarantine, ph.id, 'upload'))).toBe(true);
  // A publish that died between its PUTs and its UPDATE leaves keys without decided_at: R2 is not skipped.
  await p.owner.query(`INSERT INTO job (kind, state, payload) VALUES ('media_publish', 'failed', $1)`, [
    JSON.stringify({ media_id: ph.id }),
  ]);
  await p.db.transaction().execute((trx) => markRemoved(trx, [ph.id]));
  await expect(del(ph.id)).rejects.toMatchObject({ code: 'store_endpoint_invalid' });
  expect((await row(ph.id))?.state).toBe('removed');
});

it('rejects a payload that is not exactly {media_id}', async () => {
  await expect(mediaDeleteJob({ db: p.worker, env: {} })({ id: 'x' }, { signal })).rejects.toMatchObject({
    code: 'media_bad_payload',
    retry: false,
  });
});

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('media_delete on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  describe('media_delete on the MinIO stand-in', () => {
    const origin = new URL(minioUrl).origin;
    const real = () => server.use(http.all(`${origin}/*`, () => passthrough()));
    let c: R2Client;
    beforeAll(async () => {
      real();
      c = await minioBucket('mjk-del');
    });
    beforeEach(real);
    afterAll(async () => {
      real();
      if (c !== undefined) await dropBucket(c);
    });

    it('deletes a published photo’s R2 keys, its original and its row; other photos keep theirs', async () => {
      const publish = mediaPublishJob({
        db: p.worker,
        env: {},
        quarantineDir: quarantine,
        originalsDir: originals,
        r2: c,
      });
      const gone = await pendingPhoto(p, quarantine);
      const kept = await pendingPhoto(p, quarantine);
      for (const ph of [gone, kept]) await publish({ media_id: ph.id }, { signal });
      expect(await listKeys(c)).toEqual([...gone.keys, ...kept.keys].sort());
      expect(existsSync(join(originals, gone.id))).toBe(true);

      await p.db.transaction().execute((trx) => markRemoved(trx, [gone.id]));
      await del(gone.id, c);
      expect(await listKeys(c)).toEqual([...kept.keys].sort());
      expect(existsSync(join(originals, gone.id))).toBe(false);
      expect(existsSync(join(originals, kept.id))).toBe(true);
      expect(await row(gone.id)).toBeUndefined();
      expect(await variants(gone.id)).toBe(0);
      expect((await row(kept.id))?.state).toBe('approved');
    });

    it('a retry after the keys went (a 404 each) still finishes', async () => {
      const ph = await pendingPhoto(p, quarantine);
      await mediaPublishJob({ db: p.worker, env: {}, quarantineDir: quarantine, originalsDir: originals, r2: c })(
        { media_id: ph.id },
        { signal },
      );
      for (const key of ph.keys) await c.delete(key);
      await p.db.transaction().execute((trx) => markRemoved(trx, [ph.id]));
      await del(ph.id, c);
      expect(await row(ph.id)).toBeUndefined();
      expect(existsSync(join(originals, ph.id))).toBe(false);
    });
  });
}
