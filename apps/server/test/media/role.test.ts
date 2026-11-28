import { execFileSync, fork, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { memoryLogger } from '../../src/lib/log.ts';
import { createDecode } from '../../src/media/handoff.ts';
import { killStrays, type MediaRoleOptions, runMediaRole } from '../../src/media/role.ts';
import type { SourceFormat } from '../../src/media/types.ts';
import { noise } from './images.ts';

// The `media` role with one single-use child per task (P3b security review M2 b): the child's end in each of its
// ways (done, crashed, past the watchdog, the role stopped), the /tmp wipe and the stray sweep; and the decode of a
// large photo under the container's 64 MB RLIMIT_FSIZE (review item 6). No database.

let scratch: string;
let jpeg: Buffer;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mjk-role-'));
  jpeg = await noise(120, 80).jpeg().toBuffer();
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((res) => setTimeout(res, 10));
};

let n = 0;
/** A role on its own work directory, and the worker's Decode against it. */
async function role(over: Partial<MediaRoleOptions> = {}, jobMs = 30_000) {
  const dir = join(scratch, `r${n++}`);
  const workDir = join(dir, 'work');
  await mkdir(workDir, { recursive: true });
  const src = join(dir, 'src.jpg');
  await writeFile(src, jpeg);
  const ac = new AbortController();
  const log = memoryLogger('media');
  const done = runMediaRole({
    signal: ac.signal,
    workDir,
    heartbeatPath: join(dir, 'heartbeat'),
    logger: log.logger,
    pollMs: 20,
    ...over,
  });
  const decode = createDecode({ workDir, pollMs: 20, jobMs });
  const signal = new AbortController().signal;
  return {
    dir,
    workDir,
    run: (expect: SourceFormat = 'jpeg', path = src) => decode({ path, expect }, signal),
    msgs: () => log.lines().map((l) => l.msg),
    lines: () => log.lines(),
    stop: async () => {
      ac.abort();
      return done;
    },
    ac,
  };
}

it('decodes each task in a fresh child, reports its fixed code and peak memory, and keeps running', async () => {
  const r = await role();
  try {
    for (let i = 0; i < 2; i++) expect((await r.run()).variants).toHaveLength(2);
    // The worker reads the result while the child exits; the role logs once it has.
    const done = () => r.lines().filter((l) => l.msg === 'media_task_done');
    await waitFor(() => done().length === 2);
    expect(done()).toHaveLength(2);
    for (const l of done()) expect(l.rss_kib).toBeGreaterThan(10_000);
  } finally {
    expect(await r.stop()).toBe(0);
  }
});

it('wipes its /tmp after every task but for the heartbeat; the child writes its temporary files there', async () => {
  const tmp = join(scratch, `tmp${n}`);
  await mkdir(join(tmp, 'sub'), { recursive: true });
  const r = await role({
    container: { tmpDir: tmp, procDir: join(scratch, 'no-proc') },
    heartbeatPath: join(tmp, 'mjk-heartbeat'),
  });
  try {
    // What a compromised decoder of an earlier photo would have left for the next one.
    await writeFile(join(tmp, 'stash'), 'x');
    await writeFile(join(tmp, 'sub', 'stash'), 'x');
    await r.run();
    // The wipe follows the child's exit, which the worker does not wait for.
    let left: string[] = [];
    for (let i = 0; i < 300; i++) {
      left = await readdir(tmp);
      if (left.length === 1) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(left).toEqual(['mjk-heartbeat']);
  } finally {
    await r.stop();
  }
});

it('a child that does not start is media_decode_failed at once, and the role takes the next task', async () => {
  const r = await role({ childEnv: { NODE_OPTIONS: '--require=/nonexistent/mjk-broken.cjs' } });
  try {
    await expect(r.run()).rejects.toMatchObject({ code: 'media_decode_failed', retry: false });
    expect(r.msgs()).toContain('media_task_crashed');
    await expect(r.run()).rejects.toMatchObject({ code: 'media_decode_failed' });
  } finally {
    await r.stop();
  }
});

it('kills a child past the watchdog; the worker times out, the role stays up for the next task', async () => {
  const r = await role({ watchdogMs: 1 }, 1_500);
  try {
    await expect(r.run()).rejects.toMatchObject({ code: 'media_timeout', retry: false });
    expect(r.msgs()).toContain('media_watchdog');
    await expect(r.run()).rejects.toMatchObject({ code: 'media_timeout' });
    expect(r.msgs().filter((m) => m === 'media_watchdog')).toHaveLength(2);
  } finally {
    expect(await r.stop()).toBe(0);
  }
});

it('a stop during a task kills the child and answers media_aborted, which the worker retries', async () => {
  const r = await role();
  const pending = r.run();
  // Stop as soon as the role has taken the task.
  for (let i = 0; i < 500; i++) {
    const taken = await readdir(r.workDir).then(async (names) =>
      (await Promise.all(names.map((d) => readdir(join(r.workDir, d)).catch(() => [] as string[])))).some((f) =>
        f.includes('taken'),
      ),
    );
    if (taken) break;
    await new Promise((res) => setTimeout(res, 5));
  }
  r.ac.abort();
  await expect(pending).rejects.toMatchObject({ code: 'media_aborted', retry: true });
  expect(await r.stop()).toBe(0);
  expect(r.msgs()).toContain('media_task_aborted');
});

it('killStrays kills every other process of the namespace, and nothing unless the role is PID 1', async () => {
  const proc = join(scratch, 'proc');
  await mkdir(proc);
  const stray = spawn('sleep', ['30'], { stdio: 'ignore' });
  const gone = new Promise<string | null>((res) => stray.on('exit', (_code, sig) => res(sig)));
  for (const name of [String(process.pid), String(stray.pid), '1', 'self', 'sys']) await mkdir(join(proc, name));
  expect(await killStrays(proc)).toBe(0); // the test process is not PID 1
  expect(await killStrays(proc, true)).toBe(1);
  expect(await gone).toBe('SIGKILL');
});

it('decodes a 7,000 × 7,000 PNG and an 8,000 × 6,000 JPEG with EXIF orientation 6 under a 64 MB RLIMIT_FSIZE', async () => {
  const child = new URL('../../src/media/task-child.ts', import.meta.url);
  const cases = [
    { name: 'png', expect: 'png' as const, bytes: await noise(7000, 7000).png({ compressionLevel: 1 }).toBuffer() },
    {
      name: 'jpeg',
      expect: 'jpeg' as const,
      bytes: await noise(8000, 6000).jpeg({ quality: 80 }).withMetadata({ orientation: 6 }).toBuffer(),
    },
  ];
  for (const c of cases) {
    const dir = join(scratch, `large-${c.name}`);
    const tmp = join(scratch, `large-tmp-${c.name}`);
    await mkdir(dir);
    await mkdir(tmp);
    await writeFile(join(dir, 'in'), c.bytes);
    const p = fork(child, [], {
      execArgv: [],
      env: { ...process.env, TMPDIR: tmp },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    // compose.yaml's media ulimit; set before the child is sent its task.
    execFileSync('prlimit', ['--pid', String(p.pid), '--fsize=64000000:64000000']);
    const end = await new Promise<{ code: number | null; m: unknown }>((res) => {
      let m: unknown;
      p.on('message', (x) => {
        m = x;
      });
      p.on('exit', (code) => res({ code, m }));
      p.send({ dir, expect: c.expect, deadlineMs: Date.now() + 120_000 });
    });
    console.info(`large ${c.name}: ${JSON.stringify(end.m)}`);
    expect(end).toMatchObject({ code: 0, m: { code: 'done' } });
    expect((await readdir(dir)).sort()).toEqual([
      '1200.avif',
      '1200.webp',
      '2000.avif',
      '2000.webp',
      '400.avif',
      '400.webp',
      'in',
      'result.json',
    ]);
  }
}, 120_000);
