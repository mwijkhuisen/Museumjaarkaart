import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http, passthrough } from 'msw';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../../test/msw.setup.ts';
import { createDb } from '../../../src/db/kysely.ts';
import { silentLogger } from '../../../src/lib/log.ts';
import { createDecode } from '../../../src/media/handoff.ts';
import type { R2Client } from '../../../src/media/r2.ts';
import { runMediaRole } from '../../../src/media/role.ts';
import type { Decode } from '../../../src/media/types.ts';
import { type CommonsDeps, commonsImageJob } from '../../../src/museums/commons/image-job.ts';
import { commonsSyncJob } from '../../../src/museums/commons/sync-job.ts';
import { getMuseumDetail } from '../../../src/museums/detail.ts';
import { JobError } from '../../../src/worker/types.ts';
import { jpeg } from '../../media/fixtures.ts';
import { dropBucket, listKeys, minioBucket, minioUrl } from '../../media/pending.ts';
import { openPassportDb, type PassportDb } from '../../passport/fixtures.ts';

// P3b criterion (Commons images, ADR-0018): both jobs against msw handlers on Commons' real URLs, a generated JPEG
// as the file and the MinIO stand-in as the bucket. Skipped locally when MJK_TEST_MINIO_URL is unset, a failure
// under CI.

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('the Commons jobs on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  type F = {
    sha1: string;
    mime?: string;
    licence?: string | null;
    artist?: string | null;
    restrictions?: string;
    missing?: boolean;
    /** The file host's answer: a redirect, or other bytes. */
    redirect?: boolean;
    bytes?: Buffer;
    thumbHost?: string;
    apiRedirect?: boolean;
  };

  const sha = (n: number) => String(n).padStart(40, '0');
  const SIGNAL = new AbortController().signal;
  const API = 'https://commons.wikimedia.org/w/api.php';

  describe('commons_sync and commons_image on the MinIO stand-in', () => {
    const origin = new URL(minioUrl).origin;
    let p: PassportDb;
    let c: R2Client;
    let quarantine: string;
    let scratch: string;
    let source: Buffer;
    let variants: { avif: Buffer; webp: Buffer };
    const commons = new Map<string, F>();
    const hits: string[] = [];
    let seq = 0;

    const fakeDecode: Decode = async () => ({
      width: 1920,
      height: 1280,
      variants: [640, 1280].flatMap((width) => [
        { format: 'avif' as const, width, bytes: variants.avif },
        { format: 'webp' as const, width, bytes: variants.webp },
      ]),
    });

    beforeAll(async () => {
      server.use(http.all(`${origin}/*`, () => passthrough()));
      p = await openPassportDb();
      c = await minioBucket('mjk-commons');
      scratch = await mkdtemp(join(tmpdir(), 'mjk-commons-t-'));
      quarantine = join(scratch, 'q');
      await mkdir(quarantine, { mode: 0o700 });
      source = await jpeg();
      const img = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } });
      variants = { avif: await img().avif().toBuffer(), webp: await img().webp().toBuffer() };
    }, 180_000);
    afterAll(async () => {
      server.use(http.all(`${origin}/*`, () => passthrough()));
      if (c !== undefined) await dropBucket(c);
      await p?.close();
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    });
    beforeEach(async () => {
      commons.clear();
      hits.length = 0;
      await p.owner.query('DELETE FROM museum_image');
      await p.owner.query("DELETE FROM job WHERE kind LIKE 'commons_%'");
      await p.owner.query('UPDATE museum SET commons_file = NULL WHERE commons_file IS NOT NULL');
      server.use(
        http.all(`${origin}/*`, () => passthrough()),
        http.get(API, ({ request }) => {
          hits.push('api');
          const titles = (new URL(request.url).searchParams.get('titles') ?? '').split('|');
          const pages = titles.map((t) => {
            const name = t.replace(/^File:/, '');
            const f = commons.get(name);
            if (f === undefined || f.missing) return { ns: 6, title: t, missing: true, known: false };
            const host = f.thumbHost ?? 'upload.wikimedia.org';
            return {
              pageid: 1,
              ns: 6,
              title: t,
              imageinfo: [
                {
                  width: 2400,
                  height: 1600,
                  thumburl: `https://${host}/wikipedia/commons/thumb/a/ab/${encodeURIComponent(name)}/1920px-x.jpg`,
                  sha1: f.sha1,
                  mime: f.mime ?? 'image/jpeg',
                  extmetadata: {
                    ...(f.licence === null ? {} : { License: { value: f.licence ?? 'cc-by-sa-4.0' } }),
                    ...(f.artist === null ? {} : { Artist: { value: f.artist ?? '<a href="//x">Jane Doe</a>' } }),
                    ...(f.restrictions === undefined ? {} : { Restrictions: { value: f.restrictions } }),
                  },
                },
              ],
            };
          });
          for (const t of titles)
            if (commons.get(t.replace(/^File:/, ''))?.apiRedirect === true) {
              return new HttpResponse(null, { status: 302, headers: { location: 'https://evil.example/' } });
            }
          return HttpResponse.json({ batchcomplete: true, query: { pages } });
        }),
        http.get('https://upload.wikimedia.org/*', ({ request }) => {
          hits.push('file');
          const name = decodeURIComponent(new URL(request.url).pathname.split('/')[6] ?? '');
          const f = commons.get(name);
          if (f === undefined) return new HttpResponse(null, { status: 404 });
          if (f.redirect === true) {
            return new HttpResponse(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } });
          }
          return new HttpResponse(new Uint8Array(f.bytes ?? source), { headers: { 'content-type': 'image/jpeg' } });
        }),
      );
      for (const key of await listKeys(c)) await c.delete(key);
    });

    /** A visible museum with a commons file registered on Commons as `f`. */
    async function museum(f: F) {
      const name = `Test ${++seq}.jpg`;
      commons.set(name, f);
      const m = await p.visible(seq);
      await p.owner.query('UPDATE museum SET commons_file = $2 WHERE id = $1', [m.id, name]);
      return { ...m, name };
    }
    const deps = (over: Partial<CommonsDeps> = {}): CommonsDeps => ({
      db: p.worker,
      env: {},
      quarantineDir: quarantine,
      r2: c,
      decode: fakeDecode,
      logger: silentLogger,
      ...over,
    });
    const image = (id: string, over: Partial<CommonsDeps> = {}) =>
      commonsImageJob(deps(over))({ museum_id: id }, { signal: SIGNAL });
    const sync = (over: Partial<CommonsDeps> = {}) =>
      commonsSyncJob({ ...deps(over), sleep: async () => {} })({}, { signal: SIGNAL });
    const row = async (id: string) =>
      (
        await p.owner.query<{
          state: string;
          skip_code: string | null;
          public_key: string | null;
          sha1: string | null;
          licence: string | null;
          attribution: string | null;
          widths: number[] | null;
          file: string;
        }>('SELECT * FROM museum_image WHERE museum_id = $1', [id])
      ).rows[0];
    const queued = async () =>
      (
        await p.owner.query<{ museum_id: string; run_at: Date }>(
          "SELECT payload->>'museum_id' AS museum_id, run_at FROM job WHERE kind = 'commons_image' ORDER BY run_at",
        )
      ).rows;
    const failsWith = async (run: Promise<unknown>, code: string, retry = false) => {
      const err = await run.then(
        () => undefined,
        (e: unknown) => e as { message: string; retry?: boolean },
      );
      expect(err?.message).toBe(code);
      expect(err?.retry ?? false).toBe(retry);
    };
    const quarantineEmpty = async () => expect(await readdir(quarantine)).toEqual([]);

    it('a CC BY-SA file becomes our variants with its credit as plain text', async () => {
      const m = await museum({ sha1: sha(1) });
      await image(m.id);
      const r = await row(m.id);
      expect(r).toMatchObject({
        state: 'active',
        skip_code: null,
        sha1: sha(1),
        licence: 'cc-by-sa-4.0',
        attribution: 'Jane Doe',
        widths: [640, 1280],
        file: m.name,
      });
      const keys = (await listKeys(c)).sort();
      const want = [640, 1280].flatMap((w) => [`p/${r?.public_key}/${w}.avif`, `p/${r?.public_key}/${w}.webp`]).sort();
      expect(keys).toEqual(want);
      for (const key of keys) {
        const head = await c.send({ method: 'HEAD', key });
        expect(head.headers.get('content-type')).toBe(key.endsWith('.avif') ? 'image/avif' : 'image/webp');
        expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      }
      await quarantineEmpty();
      // mjk_ssr reads it through the barrier view, and the museum detail carries it.
      const seen = await p.pools.ssr.query(
        'SELECT public_key, widths, licence, attribution FROM pub_museum_image WHERE museum_id = $1',
        [m.id],
      );
      expect(seen.rows).toEqual([
        { public_key: r?.public_key, widths: [640, 1280], licence: 'cc-by-sa-4.0', attribution: 'Jane Doe' },
      ]);
    });

    it('a hostile Artist reaches the row as plain text of at most 200 characters', async () => {
      const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>Eve\u{202E}\u0007 &lt;b&gt;${'x'.repeat(10_000)}`;
      const m = await museum({ sha1: sha(2), artist: evil });
      await image(m.id);
      const a = (await row(m.id))?.attribution as string;
      expect([...a].length).toBeLessThanOrEqual(200);
      expect(a).toMatch(/^Eve <b>x+$/);
      expect(a).not.toMatch(/script|onerror/);
      expect([...a].filter((ch) => ch < ' ' || ch === '\u{202E}')).toEqual([]);
    });

    it.each([
      ['cc-by-nc-4.0', 'commons_licence_not_allowed'],
      ['cc-by-nd-4.0', 'commons_licence_not_allowed'],
      ['cc-by-nc-sa-3.0', 'commons_licence_not_allowed'],
      ['gfdl', 'commons_licence_not_allowed'],
      ['gfdl-with-disclaimers', 'commons_licence_not_allowed'],
      ['some-new-licence', 'commons_licence_not_allowed'],
      [null, 'commons_licence_missing'],
    ])('licence %s is skipped as %s, with nothing on the bucket', async (licence, code) => {
      const m = await museum({ sha1: sha(3), licence });
      await image(m.id);
      expect(await row(m.id)).toMatchObject({ state: 'skipped', skip_code: code, public_key: null, attribution: null });
      expect(await listKeys(c)).toEqual([]);
      expect(hits).not.toContain('file');
    });

    it('a CC BY file with no credit is skipped; a public-domain one needs none', async () => {
      const by = await museum({ sha1: sha(4), licence: 'cc-by-4.0', artist: null });
      await image(by.id);
      expect(await row(by.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_attribution_missing' });
      const pd = await museum({ sha1: sha(5), licence: 'pd', artist: null });
      await image(pd.id);
      expect(await row(pd.id)).toMatchObject({ state: 'active', licence: 'pd', attribution: null });
    });

    it('a file that is not an image, or a type outside JPEG, PNG and WebP, is skipped', async () => {
      const text = await museum({ sha1: sha(6), bytes: Buffer.from('<html>not an image</html>') });
      await image(text.id);
      expect(await row(text.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_type_not_allowed' });
      const gif = await museum({ sha1: sha(7), mime: 'image/gif' });
      await image(gif.id);
      expect(await row(gif.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_type_not_allowed' });
      expect(await listKeys(c)).toEqual([]);
      await quarantineEmpty();
    });

    it('refuses a redirect from either host and a thumbnail on another host, each with its code', async () => {
      const file = await museum({ sha1: sha(8), redirect: true });
      await failsWith(image(file.id), 'commons_redirect');
      const api = await museum({ sha1: sha(9), apiRedirect: true });
      await failsWith(image(api.id), 'commons_redirect');
      const host = await museum({ sha1: sha(10), thumbHost: 'evil.example' });
      await failsWith(image(host.id), 'commons_bad_url');
      for (const m of [file, api, host]) expect(await row(m.id)).toBeUndefined();
      expect(await listKeys(c)).toEqual([]);
      await quarantineEmpty();
    });

    it('a deleted file, a new sha1 and a relicence remove our copy', async () => {
      const gone = await museum({ sha1: sha(11) });
      const fresh = await museum({ sha1: sha(12) });
      const relic = await museum({ sha1: sha(13) });
      for (const m of [gone, fresh, relic]) await image(m.id);
      const before = new Map<string, string>();
      for (const m of [gone, fresh, relic]) before.set(m.id, (await row(m.id))?.public_key as string);
      expect((await listKeys(c)).length).toBe(12);

      Object.assign(commons.get(gone.name) as F, { missing: true });
      Object.assign(commons.get(fresh.name) as F, { sha1: sha(99) });
      Object.assign(commons.get(relic.name) as F, { licence: 'cc-by-nc-4.0' });
      await sync();

      expect(await row(gone.id)).toMatchObject({
        state: 'skipped',
        skip_code: 'commons_file_missing',
        public_key: null,
      });
      expect(await row(relic.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_licence_not_allowed' });
      // Only the new sha1 is queued; the others are already off the bucket and off the page.
      expect((await queued()).map((j) => j.museum_id)).toEqual([fresh.id]);
      expect((await listKeys(c)).every((k) => k.includes(before.get(fresh.id) as string))).toBe(true);

      await image(fresh.id);
      const after = await row(fresh.id);
      expect(after).toMatchObject({ state: 'active', sha1: sha(99) });
      expect(after?.public_key).not.toBe(before.get(fresh.id));
      const keys = await listKeys(c);
      expect(keys.length).toBe(4);
      expect(keys.every((k) => k.startsWith(`p/${after?.public_key}/`))).toBe(true);
    });

    it('queues new, renamed and changed files 10 s apart, once, and leaves unchanged ones alone', async () => {
      const a = await museum({ sha1: sha(21) });
      const b = await museum({ sha1: sha(22) });
      const d = await museum({ sha1: sha(23) });
      await sync();
      const first = await queued();
      expect(first.map((j) => j.museum_id).sort()).toEqual([a.id, b.id, d.id].sort());
      const gaps = first.slice(1).map((j, i) => j.run_at.getTime() - (first[i] as { run_at: Date }).run_at.getTime());
      for (const g of gaps) expect(Math.abs(g - 10_000)).toBeLessThan(1500);
      await sync(); // already queued: no second job
      expect(await queued()).toHaveLength(3);

      await p.owner.query("DELETE FROM job WHERE kind = 'commons_image'");
      for (const m of [a, b, d]) await image(m.id);
      await sync();
      expect(await queued()).toEqual([]); // nothing changed
      // A renamed file (the museum's P18 changed) is a new image.
      const renamed = `Renamed ${seq}.jpg`;
      commons.set(renamed, { sha1: sha(21) });
      await p.owner.query('UPDATE museum SET commons_file = $2 WHERE id = $1', [a.id, renamed]);
      await sync();
      expect((await queued()).map((j) => j.museum_id)).toEqual([a.id]);
    });

    it('a museum that lost its commons_file loses its copy and its row', async () => {
      const m = await museum({ sha1: sha(31) });
      await image(m.id);
      expect((await listKeys(c)).length).toBe(4);
      await p.owner.query('UPDATE museum SET commons_file = NULL WHERE id = $1', [m.id]);
      await sync();
      expect(await row(m.id)).toBeUndefined();
      expect(await listKeys(c)).toEqual([]);
    });

    it('a hidden image is never re-activated; the job deletes its objects and stops', async () => {
      const m = await museum({ sha1: sha(41) });
      await image(m.id);
      expect((await listKeys(c)).length).toBe(4);
      // `admin museum image hide` as mjk_api: the state only.
      await p.pools.api.query("UPDATE museum_image SET state = 'hidden' WHERE museum_id = $1", [m.id]);
      expect((await p.pools.ssr.query('SELECT 1 FROM pub_museum_image WHERE museum_id = $1', [m.id])).rowCount).toBe(0);
      await image(m.id);
      expect(await listKeys(c)).toEqual([]);
      expect(await row(m.id)).toMatchObject({
        state: 'hidden',
        public_key: null,
        widths: null,
        skip_code: 'commons_hidden',
      });
      Object.assign(commons.get(m.name) as F, { sha1: sha(42) });
      await sync();
      await image(m.id);
      expect(await row(m.id)).toMatchObject({ state: 'hidden', public_key: null });
      expect(await queued()).toEqual([]);
      // unhide: skipped, and the job fetches it again.
      await p.pools.api.query("UPDATE museum_image SET state = 'skipped' WHERE museum_id = $1", [m.id]);
      await image(m.id);
      expect(await row(m.id)).toMatchObject({ state: 'active', sha1: sha(42) });
      expect((await listKeys(c)).length).toBe(4);
    });

    it('a failure part-way deletes what this run put and leaves the previous image', async () => {
      const m = await museum({ sha1: sha(51) });
      await image(m.id);
      const old = await row(m.id);
      const oldKeys = await listKeys(c);
      Object.assign(commons.get(m.name) as F, { sha1: sha(52) });
      let n = 0;
      const flaky = {
        put: (...args: Parameters<R2Client['put']>) => {
          if (++n === 3) throw new Error('boom');
          return c.put(...args);
        },
        delete: (...args: Parameters<R2Client['delete']>) => c.delete(...args),
      } as unknown as R2Client;
      await expect(image(m.id, { r2: flaky })).rejects.toThrow('boom');
      expect(await row(m.id)).toEqual(old);
      expect(await listKeys(c)).toEqual(oldKeys);
      await quarantineEmpty();
    });

    it('a hostile decoder answer or a failed decode leaves no directory behind', async () => {
      const m = await museum({ sha1: sha(61) });
      const bad: Decode = async () => {
        throw new Error('decode failed');
      };
      await expect(image(m.id, { decode: bad })).rejects.toThrow('decode failed');
      expect(await row(m.id)).toBeUndefined();
      expect(await listKeys(c)).toEqual([]);
      await quarantineEmpty();
    });

    it('a rendering that does not decode is skipped, and the sync does not fetch it again (code review L5)', async () => {
      const m = await museum({ sha1: sha(71) });
      const bad: Decode = async () => {
        throw new JobError('media_decode_failed', { retry: false });
      };
      await image(m.id, { decode: bad });
      expect(await row(m.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_decode_failed', sha1: sha(71) });
      expect(await listKeys(c)).toEqual([]);
      await quarantineEmpty();
      await sync();
      expect(await queued()).toEqual([]);
      // A new sha1 is a new try.
      Object.assign(commons.get(m.name) as F, { sha1: sha(72) });
      await sync();
      expect((await queued()).map((q) => q.museum_id)).toEqual([m.id]);
      // A retryable failure (the role never took it) writes nothing and is retried.
      const busy: Decode = async () => {
        throw new JobError('media_not_taken');
      };
      await failsWith(image(m.id, { decode: busy }), 'media_not_taken', true);
      expect(await row(m.id)).toMatchObject({ skip_code: 'commons_decode_failed', sha1: sha(71) });
    });

    it('a file with any Restrictions is skipped, and taken again once they are gone (security review L4)', async () => {
      const m = await museum({ sha1: sha(81), restrictions: 'personality' });
      await image(m.id);
      expect(await row(m.id)).toMatchObject({ state: 'skipped', skip_code: 'commons_restricted' });
      expect(await listKeys(c)).toEqual([]);
      expect(hits).not.toContain('file');
      delete (commons.get(m.name) as F).restrictions;
      await sync();
      expect((await queued()).map((q) => q.museum_id)).toEqual([m.id]);
    });

    it('the row goes before the objects when the file is gone, so a failed delete never leaves a row naming them (L6)', async () => {
      const failing = {
        put: (...args: Parameters<R2Client['put']>) => c.put(...args),
        delete: () => Promise.reject(new Error('boom')),
      } as unknown as R2Client;
      for (const run of [(id: string) => image(id, { r2: failing }), () => sync({ r2: failing })]) {
        const m = await museum({ sha1: sha(90 + seq) });
        await image(m.id);
        await p.owner.query('UPDATE museum SET commons_file = NULL WHERE id = $1', [m.id]);
        await expect(run(m.id)).rejects.toThrow('boom');
        expect(await row(m.id)).toBeUndefined();
        for (const key of await listKeys(c)) await c.delete(key);
      }
    });

    it('a malformed payload fails the job without retry', async () => {
      await failsWith(commonsImageJob(deps())({ museum_id: 'nope' }, { signal: SIGNAL }), 'commons_bad_payload');
    });

    it('through the real media role: the variants on the bucket match the row', async () => {
      const work = join(scratch, 'work');
      await mkdir(work, { mode: 0o700 });
      const ac = new AbortController();
      const done = runMediaRole({
        signal: ac.signal,
        workDir: work,
        heartbeatPath: join(scratch, 'heartbeat'),
        logger: silentLogger,
        pollMs: 50,
      });
      try {
        const big = await sharp({
          create: {
            width: 1500,
            height: 1000,
            channels: 3,
            background: '#4a6b8c',
            noise: { type: 'gaussian', mean: 128, sigma: 8 },
          },
        })
          .jpeg()
          .toBuffer();
        const m = await museum({ sha1: sha(71), bytes: big });
        await image(m.id, { decode: createDecode({ workDir: work, pollMs: 20 }) });
        const r = await row(m.id);
        expect(r?.state).toBe('active');
        const widths = r?.widths as number[];
        expect(widths.at(-1)).toBe(1500);
        const want = widths.flatMap((w) => [`p/${r?.public_key}/${w}.avif`, `p/${r?.public_key}/${w}.webp`]).sort();
        expect(await listKeys(c)).toEqual(want);
        await quarantineEmpty();
      } finally {
        ac.abort();
        await done;
      }
    }, 120_000);

    it('the museum detail carries the active image and null otherwise', async () => {
      const m = await museum({ sha1: sha(91) });
      const detail = () => getMuseumDetail(createDb(p.pools.api), m.slug);
      expect((await detail())?.image).toBeNull();
      await image(m.id);
      const r = await row(m.id);
      expect((await detail())?.image).toEqual({
        public_key: r?.public_key,
        widths: [640, 1280],
        width: 1920,
        height: 1280,
        licence: 'cc-by-sa-4.0',
        attribution: 'Jane Doe',
        file: m.name,
      });
      await p.pools.api.query("UPDATE museum_image SET state = 'hidden' WHERE museum_id = $1", [m.id]);
      expect((await detail())?.image).toBeNull();
    });

    it('pub_museum_image shows only active rows of visible museums', async () => {
      const act = await museum({ sha1: sha(81) });
      const skip = await museum({ sha1: sha(82), licence: 'gfdl' });
      const hid = await museum({ sha1: sha(83) });
      const hiddenMuseum = await museum({ sha1: sha(84) });
      for (const m of [act, skip, hid, hiddenMuseum]) await image(m.id);
      await p.pools.api.query("UPDATE museum_image SET state = 'hidden' WHERE museum_id = $1", [hid.id]);
      await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [hiddenMuseum.id]);
      const seen = await p.pools.ssr.query<{ museum_id: string }>('SELECT museum_id FROM pub_museum_image');
      expect(seen.rows.map((r) => r.museum_id)).toEqual([act.id]);
      await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [hiddenMuseum.id]);
    });
  });
}
