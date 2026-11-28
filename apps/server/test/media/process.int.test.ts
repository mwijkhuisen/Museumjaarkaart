import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/lib/log.ts';
import { createDecode, type HandoffSeams } from '../../src/media/handoff.ts';
import { mediaProcessJob } from '../../src/media/process-job.ts';
import { runMediaRole } from '../../src/media/role.ts';
import { type Decode, MEDIA_PROCESS_JOB, MEDIA_PUBLISH_JOB, variantKey } from '../../src/media/types.ts';
import { runWorker } from '../../src/worker/worker.ts';
import { openUploads, type UploadsFixture } from './fixtures.ts';
import { bombPng, CANARY, canaryJpeg, noise } from './images.ts';

// P3b criteria 2 and 3 at role level: the `media_process` job end to end against the database, with the real
// `media` role running in-process on a temp work directory, and fake decoders that misbehave (never answer, plant
// links, swap the task directory). A final failure ends the photo and the job `failed` with its code and removes
// the quarantine files; a decoder's trick is `media_bad_output` and no byte of its target reaches quarantine.

let f: UploadsFixture;
let museumId: string;
let scratch: string;
let workDir: string;
let stopRole: () => Promise<void>;

beforeAll(async () => {
  f = await openUploads();
  museumId = (await f.p.visible(0)).id;
  scratch = await mkdtemp(join(tmpdir(), 'mjk-media-'));
  workDir = join(scratch, 'work');
  await mkdir(workDir, { mode: 0o700 });
  const ac = new AbortController();
  const done = runMediaRole({
    signal: ac.signal,
    workDir,
    heartbeatPath: join(scratch, 'heartbeat'),
    logger: silentLogger,
    pollMs: 50,
  });
  stopRole = async () => {
    ac.abort();
    await done;
  };
}, 180_000);
afterAll(async () => {
  await stopRole?.();
  await rm(scratch, { recursive: true, force: true });
  await f?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A member with a visit and a visible review of the museum. */
async function member(opts: { trusted?: boolean } = {}) {
  const u = await f.p.newMember();
  if (opts.trusted) await f.p.owner.query('UPDATE app_user SET trusted_at = now() WHERE id = $1', [u.id]);
  const visit = await f.p.addVisit(u.id, museumId);
  const review = await f.p.owner.query<{ id: string }>(
    'INSERT INTO review (user_id, museum_id, visit_id, rating) VALUES ($1, $2, $3, 4) RETURNING id',
    [u.id, museumId, visit],
  );
  return { ...u, token: await f.t.signIn(u.id), reviewId: review.rows[0]?.id as string };
}

/** A completed upload, `quarantined` with its `media_process` job; attached to the review when asked. */
async function quarantined(m: Awaited<ReturnType<typeof member>>, bytes: Buffer, type = 'image/jpeg', attach = false) {
  const { id, done } = await f.upload(m.token, museumId, bytes, type);
  expect(done.status).toBe(202);
  if (attach) await f.p.owner.query('UPDATE media SET review_id = $2 WHERE id = $1', [id, m.reviewId]);
  return id;
}

const media = async (id: string) =>
  (
    await f.p.owner.query<{
      state: string;
      error_code: string | null;
      width: number | null;
      height: number | null;
      public_key: string | null;
    }>('SELECT state, error_code, width, height, public_key FROM media WHERE id = $1', [id])
  ).rows[0];

type Job = { state: string; last_error: string | null; attempts: number };

const jobs = async (id: string, kind: string) =>
  (
    await f.p.owner.query<Job>(
      `SELECT state, last_error, attempts FROM job WHERE kind = $2 AND payload->>'media_id' = $1 ORDER BY id`,
      [id, kind],
    )
  ).rows;

/** Runs the real worker loop with `media_process` on `decode` until each photo's job has been attempted. */
async function runJobs(ids: readonly string[], decode: Decode) {
  const ac = new AbortController();
  const done = runWorker({
    db: f.p.worker,
    listen: () => new pg.Client({ connectionString: f.p.tdb.urls.mjk_worker }),
    handlers: { [MEDIA_PROCESS_JOB]: mediaProcessJob({ db: f.p.worker, quarantineDir: f.root, decode }) },
    logger: silentLogger,
    signal: ac.signal,
    workerId: 'w-media',
    pollMs: 50,
    heartbeatPath: join(scratch, 'worker-heartbeat'),
  });
  try {
    for (let i = 0; i < 600; i++) {
      const all: Job[] = [];
      for (const id of ids) {
        const [job] = await jobs(id, MEDIA_PROCESS_JOB); // one owner client: one query at a time
        if (job !== undefined && (job.state !== 'queued' || job.attempts > 0) && job.state !== 'running') all.push(job);
      }
      if (all.length === ids.length) return all;
      await sleep(50);
    }
    throw new Error('the job was not attempted in time');
  } finally {
    ac.abort();
    await done;
  }
}

const runJob = async (id: string, decode: Decode) => (await runJobs([id], decode))[0] as Job;

/** Every file under `dir`, recursively (lstat: links are listed, never followed). */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

async function quarantineHolds(marker: string | Buffer): Promise<boolean> {
  for (const file of await filesUnder(f.root)) if ((await readFile(file)).includes(marker)) return true;
  return false;
}

const realDecode = (seams: HandoffSeams = {}) => createDecode({ workDir, pollMs: 20, ...seams });

describe('media_process with the real media role', () => {
  it('turns a quarantined JPEG into pending_review with its variants, and no metadata', async () => {
    const m = await member();
    const id = await quarantined(m, await canaryJpeg());
    expect((await runJob(id, realDecode())).state).toBe('done');

    const row = await media(id);
    expect(row).toMatchObject({ state: 'pending_review', error_code: null, width: 600, height: 400 });
    expect(row?.public_key).toMatch(/^[0-9a-f]{32}$/);
    const variants = await f.p.owner.query<{ format: string; width: number; object_key: string; bytes: number }>(
      'SELECT format, width, object_key, bytes FROM media_variant WHERE media_id = $1 ORDER BY width, format',
      [id],
    );
    expect(variants.rows.map((v) => `${v.width}.${v.format}`)).toEqual([
      '400.avif',
      '400.webp',
      '600.avif',
      '600.webp',
    ]);
    for (const v of variants.rows) {
      expect(v.object_key).toBe(variantKey(row?.public_key as string, v.format as 'avif' | 'webp', v.width));
      const file = await readFile(join(f.root, id, 'v', `${v.width}.${v.format}`));
      expect(file.length).toBe(v.bytes);
      expect(file.includes(CANARY)).toBe(false);
    }
    expect(await exists(join(f.root, id, 'upload'))).toBe(true); // the original stays for the publish job
    expect(await jobs(id, MEDIA_PUBLISH_JOB)).toEqual([]); // not trusted, not attached
    expect(await readdir(workDir)).toEqual([]);
  }, 60_000);

  it('enqueues one media_publish for a trusted member attached photo, none otherwise', async () => {
    const trusted = await member({ trusted: true });
    const untrusted = await member();
    const attached = await quarantined(trusted, await noise(120, 80).jpeg().toBuffer(), 'image/jpeg', true);
    const unattached = await quarantined(trusted, await noise(120, 80).jpeg().toBuffer());
    const other = await quarantined(untrusted, await noise(120, 80).jpeg().toBuffer(), 'image/jpeg', true);
    // A trusted member banned meanwhile: their trust no longer counts (P3b review L3).
    const banned = await member({ trusted: true });
    const ofBanned = await quarantined(banned, await noise(120, 80).jpeg().toBuffer(), 'image/jpeg', true);
    await f.p.owner.query(`UPDATE app_user SET status = 'banned' WHERE id = $1`, [banned.id]);
    const done = await runJobs([attached, unattached, other, ofBanned], realDecode());
    expect(done.map((j) => j.state)).toEqual(['done', 'done', 'done', 'done']);
    expect((await jobs(attached, MEDIA_PUBLISH_JOB)).length).toBe(1);
    expect(await jobs(unattached, MEDIA_PUBLISH_JOB)).toEqual([]);
    expect(await jobs(other, MEDIA_PUBLISH_JOB)).toEqual([]);
    expect(await jobs(ofBanned, MEDIA_PUBLISH_JOB)).toEqual([]);
    for (const id of [attached, unattached, other, ofBanned]) expect((await media(id))?.state).toBe('pending_review');
  }, 60_000);

  it('fails a decompression bomb with media_too_many_pixels, then processes the next photo', async () => {
    const m = await member();
    const bomb = await quarantined(m, bombPng(), 'image/png');
    const job = await runJob(bomb, realDecode());
    expect(job).toMatchObject({ state: 'failed', last_error: 'media_too_many_pixels' });
    expect(await media(bomb)).toMatchObject({ state: 'failed', error_code: 'media_too_many_pixels' });
    expect(await exists(join(f.root, bomb))).toBe(false);

    const next = await quarantined(m, await noise(120, 80).jpeg().toBuffer());
    expect((await runJob(next, realDecode())).state).toBe('done');
    expect((await media(next))?.state).toBe('pending_review');
  }, 60_000);

  it('retries a task the role never takes: the photo goes back to quarantined, the upload is kept', async () => {
    const idle = await mkdtemp(join(scratch, 'idle-'));
    const m = await member();
    const id = await quarantined(m, await noise(120, 80).jpeg().toBuffer());
    const job = await runJob(id, createDecode({ workDir: idle, takeMs: 300, pollMs: 20 }));
    expect(job).toMatchObject({ state: 'queued', last_error: 'media_not_taken' });
    expect((await media(id))?.state).toBe('quarantined');
    expect(await exists(join(f.root, id, 'upload'))).toBe(true);
    expect(await readdir(idle)).toEqual([]);
  });
});

/** A fake decoder on its own work directory: takes every task and does `behave` with it. */
async function withFakeDecoder<T>(behave: (dir: string) => Promise<void>, run: (decode: Decode) => Promise<T>) {
  const work = await mkdtemp(join(scratch, 'fake-'));
  const ac = new AbortController();
  const loop = (async () => {
    while (!ac.signal.aborted) {
      for (const name of await readdir(work)) {
        const dir = join(work, name);
        try {
          await rename(join(dir, 'ready'), join(dir, 'taken'));
        } catch {
          continue;
        }
        await behave(dir);
      }
      await sleep(20);
    }
  })();
  try {
    return { result: await run(createDecode({ workDir: work, jobMs: 2_000, pollMs: 20 })), work };
  } finally {
    ac.abort();
    await loop;
  }
}

describe('media_process with a misbehaving decoder', () => {
  /** 16 bytes from the middle of the noise WebP: random pixels, so no other file holds them. */
  let MARKER: Buffer;
  let outside: string;
  let avif: Buffer;
  let webp: Buffer;
  const result = JSON.stringify({
    ok: true,
    width: 64,
    height: 48,
    files: [
      { format: 'avif', width: 64 },
      { format: 'webp', width: 64 },
    ],
  });

  beforeAll(async () => {
    // Valid outputs whose noise is the marker: only the trick (a link, a swap) may refuse them.
    avif = await noise(64, 48).avif().toBuffer();
    webp = await noise(64, 48).webp().toBuffer();
    MARKER = Buffer.from(webp.subarray(webp.length >> 1, (webp.length >> 1) + 16));
    outside = await mkdtemp(join(scratch, 'outside-'));
    await writeFile(join(outside, '64.avif'), avif);
    await writeFile(join(outside, '64.webp'), webp);
    await writeFile(join(outside, 'result.json'), result);
  });

  async function expectBadOutput(id: string, job: { state: string; last_error: string | null }) {
    expect(job).toMatchObject({ state: 'failed', last_error: 'media_bad_output' });
    expect(await media(id)).toMatchObject({ state: 'failed', error_code: 'media_bad_output' });
    expect(await exists(join(f.root, id))).toBe(false);
    expect(await quarantineHolds(MARKER)).toBe(false);
    // The targets are untouched: the cleanup never followed a link.
    for (const name of ['64.avif', '64.webp', 'result.json']) expect(await exists(join(outside, name))).toBe(true);
  }

  it('control: the same outputs as regular files are accepted', async () => {
    const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
    const { result: job } = await withFakeDecoder(
      async (dir) => {
        await writeFile(join(dir, '64.avif'), avif);
        await writeFile(join(dir, '64.webp'), webp);
        await writeFile(join(dir, 'result.json'), result);
      },
      (decode) => runJob(id, decode),
    );
    expect(job.state).toBe('done');
    expect(await quarantineHolds(MARKER)).toBe(true);
    await rm(join(f.root, id), { recursive: true });
  });

  it('a variant that is a link to a file outside the work directory → media_bad_output', async () => {
    const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
    const { result: job, work } = await withFakeDecoder(
      async (dir) => {
        await symlink(join(outside, '64.avif'), join(dir, '64.avif'));
        await writeFile(join(dir, '64.webp'), webp);
        await writeFile(join(dir, 'result.json'), result);
      },
      (decode) => runJob(id, decode),
    );
    await expectBadOutput(id, job);
    expect(await readdir(work)).toEqual([]);
  });

  it('a result.json that is a link → media_bad_output', async () => {
    const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
    const { result: job, work } = await withFakeDecoder(
      async (dir) => {
        await writeFile(join(dir, '64.avif'), avif);
        await writeFile(join(dir, '64.webp'), webp);
        await symlink(join(outside, 'result.json'), join(dir, 'result.json'));
      },
      (decode) => runJob(id, decode),
    );
    await expectBadOutput(id, job);
    expect(await readdir(work)).toEqual([]);
  });

  it('a task directory renamed and replaced by a link → media_bad_output', async () => {
    const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
    let moved = '';
    const { result: job, work } = await withFakeDecoder(
      async (dir) => {
        // The answer stays in the real directory; the variants it names exist only behind the link.
        moved = `${dir}.moved`;
        await rename(dir, moved);
        await symlink(outside, dir);
        await writeFile(join(moved, 'result.json'), result);
      },
      (decode) => runJob(id, decode),
    );
    await expectBadOutput(id, job);
    // The link is gone; the moved directory was emptied through the worker's descriptor (the sweeper takes it).
    expect(await readdir(work)).toEqual([moved.slice(work.length + 1)]);
    expect(await readdir(moved)).toEqual([]);
  });

  // The container, not only the magic bytes (P3b security review M2): metadata put back into a variant, or a
  // variant of another size, never reaches quarantine.
  for (const [name, make] of [
    [
      'a WebP with an EXIF chunk',
      () =>
        noise(64, 48)
          .webp()
          .withExif({ IFD0: { Copyright: 'MJKEXIF' } }),
    ],
    ['a WebP with an ICC profile', () => noise(64, 48).webp().withIccProfile('p3')],
    ['a WebP with trailing bytes', undefined],
    ['a WebP two pixels taller than the aspect gives', () => noise(64, 50).webp()],
  ] as const) {
    it(`${name} → media_bad_output`, async () => {
      const bad = make === undefined ? Buffer.concat([webp, Buffer.from('MJKTAIL')]) : await make().toBuffer();
      const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
      const { result: job, work } = await withFakeDecoder(
        async (dir) => {
          await writeFile(join(dir, '64.avif'), avif);
          await writeFile(join(dir, '64.webp'), bad);
          await writeFile(join(dir, 'result.json'), result);
        },
        (decode) => runJob(id, decode),
      );
      expect(job).toMatchObject({ state: 'failed', last_error: 'media_bad_output' });
      expect(await exists(join(f.root, id))).toBe(false);
      expect(await readdir(work)).toEqual([]);
    });
  }

  it('a decoder that takes the task and never answers → media_timeout, quarantine removed', async () => {
    const id = await quarantined(await member(), await noise(64, 48).jpeg().toBuffer());
    const { result: job, work } = await withFakeDecoder(
      async () => {},
      (decode) => runJob(id, decode),
    );
    expect(job).toMatchObject({ state: 'failed', last_error: 'media_timeout' });
    expect(await media(id)).toMatchObject({ state: 'failed', error_code: 'media_timeout' });
    expect(await exists(join(f.root, id))).toBe(false);
    expect(await readdir(work)).toEqual([]);
  });
});
