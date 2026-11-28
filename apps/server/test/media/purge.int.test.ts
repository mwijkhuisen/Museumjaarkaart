import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lutimes, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/log.ts';
import { purge } from '../../src/worker/purge.ts';
import { jpeg, openUploads, type UploadsFixture } from './fixtures.ts';
import { pendingPhoto } from './pending.ts';

// The photo sweepers of the retention purge (A§12, A§13.2), with rows backdated by the owner (no fake clock): an
// upload left unfinished for 24 h, failed photos, unattached ones after 7 days (N1), stalled processing, removed
// photos without a delete job, and orphan directories in quarantine and media-work (lstat only).

let f: UploadsFixture;
let mediaWork: string;
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  f = await openUploads();
  mediaWork = await mkdtemp(join(tmpdir(), 'mjk-mw-'));
}, 180_000);
afterAll(async () => {
  await f?.close();
  if (mediaWork !== undefined) await rm(mediaWork, { recursive: true, force: true });
});

const q = (text: string, values: unknown[] = []) => f.p.owner.query(text, values);
const run = () => purge(f.p.worker, quiet, { quarantineDir: f.root, mediaWorkDir: mediaWork });
const stateOf = async (id: string) =>
  (await q('SELECT state, error_code FROM media WHERE id = $1', [id])).rows[0] as
    | { state: string; error_code: string | null }
    | undefined;
const jobs = async (kind: string, id: string) =>
  Number(
    (await q(`SELECT count(*) AS n FROM job WHERE kind = $1 AND payload->>'media_id' = $2`, [kind, id])).rows[0].n,
  );
/** Backdates a photo; the trigger would reset updated_at, so it is off for this one statement. */
async function age(id: string, created: string, updated = created) {
  await q('ALTER TABLE media DISABLE TRIGGER media_set_updated_at');
  try {
    await q(`UPDATE media SET created_at = now() - $2::interval, updated_at = now() - $3::interval WHERE id = $1`, [
      id,
      created,
      updated,
    ]);
  } finally {
    await q('ALTER TABLE media ENABLE TRIGGER media_set_updated_at');
  }
}
const old = (path: string) => utimes(path, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));

it('purges an upload left unfinished for 24 h: the row, its chunks and its file; a younger one stays', async () => {
  const museumId = (await f.p.visible(0)).id;
  const u = await f.p.newMember();
  const token = await f.t.signIn(u.id);
  const open = async () => {
    const bytes = await jpeg();
    const made = await f.create(token, { museumId, size: bytes.length + 1 });
    const { id } = (await made.json()) as { id: string };
    // Its one chunk received, `complete` never sent.
    expect((await f.put(token, id, 0, Buffer.concat([bytes, Buffer.alloc(1)]))).status).toBe(204);
    return id;
  };
  const stale = await open();
  const young = await open();
  expect(Number((await q('SELECT count(*) AS n FROM media_chunk WHERE media_id = $1', [stale])).rows[0].n)).toBe(1);
  await age(stale, '24 hours 1 minute');
  await age(young, '23 hours 59 minutes');
  const counts = await run();
  expect(counts.media_uploading).toBe(1);
  expect(await stateOf(stale)).toBeUndefined();
  expect(Number((await q('SELECT count(*) AS n FROM media_chunk WHERE media_id = $1', [stale])).rows[0].n)).toBe(0);
  expect(existsSync(join(f.root, stale))).toBe(false);
  expect((await stateOf(young))?.state).toBe('uploading');
  expect(existsSync(join(f.root, young, 'upload'))).toBe(true);
});

it('removes failed photos a day after they failed, files and row', async () => {
  const ph = await pendingPhoto(f.p, f.root, { trusted: false });
  const fresh = await pendingPhoto(f.p, f.root, { trusted: false });
  await q(`UPDATE media SET state = 'failed', error_code = 'x' WHERE id = ANY($1)`, [[ph.id, fresh.id]]);
  await age(ph.id, '3 days', '24 hours 1 minute');
  await age(fresh.id, '3 days', '23 hours');
  expect((await run()).media_failed).toBe(1);
  expect(await stateOf(ph.id)).toBeUndefined();
  expect(existsSync(join(f.root, ph.id))).toBe(false);
  expect((await stateOf(fresh.id))?.state).toBe('failed');
});

it('removes a photo still unattached 7 days after its create (N1) and queues its media_delete', async () => {
  const stale = await pendingPhoto(f.p, f.root, { attached: false });
  const young = await pendingPhoto(f.p, f.root, { attached: false });
  const attached = await pendingPhoto(f.p, f.root);
  await age(stale.id, '7 days 1 minute');
  await age(young.id, '6 days 23 hours');
  await age(attached.id, '30 days');
  expect((await run()).media_unattached).toBe(1);
  expect((await stateOf(stale.id))?.state).toBe('removed');
  expect(await jobs('media_delete', stale.id)).toBe(1);
  expect((await stateOf(young.id))?.state).toBe('pending_review');
  expect((await stateOf(attached.id))?.state).toBe('pending_review');
  expect(await jobs('media_delete', young.id)).toBe(0);
});

it('fails a photo stuck in quarantined or processing without its media_process job (media_stalled)', async () => {
  const mk = async (state: string, updated: string, job?: string) => {
    const ph = await pendingPhoto(f.p, f.root, { trusted: false });
    await q('UPDATE media SET state = $2 WHERE id = $1', [ph.id, state]);
    await age(ph.id, '1 day', updated);
    if (job !== undefined)
      await q(`INSERT INTO job (kind, state, payload) VALUES ('media_process', $1, $2)`, [
        job,
        JSON.stringify({ media_id: ph.id }),
      ]);
    return ph.id;
  };
  const stuck = await mk('quarantined', '61 minutes');
  const stuckFailedJob = await mk('processing', '2 hours', 'failed');
  const queued = await mk('quarantined', '5 hours', 'queued');
  const running = await mk('processing', '5 hours', 'running');
  const young = await mk('processing', '59 minutes');
  expect((await run()).media_stalled).toBe(2);
  for (const id of [stuck, stuckFailedJob]) {
    expect(await stateOf(id)).toEqual({ state: 'failed', error_code: 'media_stalled' });
    expect(existsSync(join(f.root, id))).toBe(false);
  }
  for (const id of [queued, running, young]) {
    expect((await stateOf(id))?.state).not.toBe('failed');
    expect(existsSync(join(f.root, id, 'upload'))).toBe(true);
  }
});

it('queues another media_delete for a removed photo whose job is gone, never a second open one', async () => {
  const mk = async (updated: string, job?: string) => {
    const ph = await pendingPhoto(f.p, f.root, { trusted: false });
    await q(`UPDATE media SET state = 'removed' WHERE id = $1`, [ph.id]);
    await age(ph.id, '1 day', updated);
    if (job !== undefined)
      await q(`INSERT INTO job (kind, state, payload) VALUES ('media_delete', $1, $2)`, [
        job,
        JSON.stringify({ media_id: ph.id }),
      ]);
    return ph.id;
  };
  const lost = await mk('2 hours');
  const failedJob = await mk('2 hours', 'failed');
  const queued = await mk('2 hours', 'queued');
  const young = await mk('30 minutes');
  expect((await run()).media_requeued).toBe(2);
  expect(await jobs('media_delete', lost)).toBe(1);
  expect(await jobs('media_delete', failedJob)).toBe(2);
  expect(await jobs('media_delete', queued)).toBe(1);
  expect(await jobs('media_delete', young)).toBe(0);
  // The new ones are open, so the next run adds none.
  expect((await run()).media_requeued).toBe(0);
});

it('removes hour-old orphan entries of quarantine and media-work, never following a link', async () => {
  const live = await pendingPhoto(f.p, f.root, { trusted: false });
  const approved = await pendingPhoto(f.p, f.root, { trusted: false });
  await q(`UPDATE media SET state = 'approved' WHERE id = $1`, [approved.id]);
  const orphan = randomUUID();
  const youngOrphan = randomUUID();
  const outside = await mkdtemp(join(tmpdir(), 'mjk-outside-'));
  await writeFile(join(outside, 'keep'), 'x');
  for (const d of [orphan, youngOrphan, 'not-a-uuid']) await mkdir(join(f.root, d));
  await writeFile(join(f.root, orphan, 'upload'), 'x');
  await symlink(outside, join(f.root, 'a-link'));
  for (const d of [live.id, approved.id, orphan, 'not-a-uuid']) await old(join(f.root, d));
  // lutimes: the link's own mtime, not its target's.
  await lutimes(join(f.root, 'a-link'), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  const task = join(mediaWork, 'c0ffee');
  const youngTask = join(mediaWork, 'beef');
  for (const d of [task, youngTask]) await mkdir(d);
  await writeFile(join(task, 'in'), 'x');
  // A planted tree deeper than the old descriptor walk's limit of 4, with a link to outside half way (M1).
  const deep = join(task, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'f'), 'x');
  await symlink(outside, join(task, 'a', 'b', 'c', 'link'));
  await old(task);

  const counts = await run();
  expect(counts.media_orphan_dirs).toBe(4);
  expect(counts.media_work_dirs).toBe(1);
  const left = await readdir(f.root);
  expect(left).toContain(live.id);
  expect(left).toContain(youngOrphan);
  for (const gone of [orphan, approved.id, 'not-a-uuid', 'a-link']) expect(left).not.toContain(gone);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  expect(await readdir(mediaWork)).toEqual(['beef']);
  await rm(outside, { recursive: true, force: true });
});

it('a second run finds nothing more to do', async () => {
  const counts = await run();
  for (const k of Object.keys(counts).filter((k) => k.startsWith('media_'))) expect(counts[k], k).toBe(0);
});
