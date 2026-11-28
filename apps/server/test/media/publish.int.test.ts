import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HttpResponse, http, passthrough } from 'msw';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { parseBackupConfig, resticBackupArgs, resticEnv } from '../../src/backup/plan.ts';
import { mediaPublishJob, type PublishDeps } from '../../src/media/publish.ts';
import type { R2Client } from '../../src/media/r2.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { dropBucket, listKeys, minioBucket, minioUrl, type Pending, pendingPhoto } from './pending.ts';

// P3b criteria 8 and 9 (the bucket and the backup): `media_publish` on the MinIO stand-in. A trusted member's
// attached photo lands on the bucket with the exact headers and keys and its original in originals; anything
// else (untrusted, unattached, trust revoked before the approving UPDATE, a failure part-way) leaves nothing on
// the bucket and no original. The restic part runs the backup role's restic invocation over the originals.
// Skipped locally when MJK_TEST_MINIO_URL is unset, a failure under CI.

const exec = promisify(execFile);
const KEY = /^p\/[0-9a-f]{32}\/[0-9]{1,4}\.(avif|webp)$/;

if (minioUrl === '') {
  if (process.env.CI) {
    it('MJK_TEST_MINIO_URL is set in CI', () => {
      expect.fail('MJK_TEST_MINIO_URL must name the MinIO stand-in in CI');
    });
  } else {
    it.skip('media_publish on the MinIO stand-in (skipped: MJK_TEST_MINIO_URL is not set)', () => {});
  }
} else {
  describe('media_publish on the MinIO stand-in', () => {
    const origin = new URL(minioUrl).origin;
    const real = () => server.use(http.all(`${origin}/*`, () => passthrough()));
    let p: PassportDb;
    let c: R2Client;
    let quarantine: string;
    let originals: string;
    const signal = new AbortController().signal;

    beforeAll(async () => {
      real();
      p = await openPassportDb();
      c = await minioBucket('mjk-pub');
      quarantine = await mkdtemp(join(tmpdir(), 'mjk-q-'));
      originals = await mkdtemp(join(tmpdir(), 'mjk-orig-'));
    }, 180_000);
    beforeEach(real);
    afterAll(async () => {
      real();
      if (c !== undefined) await dropBucket(c);
      await p?.close();
      for (const d of [quarantine, originals]) if (d !== undefined) await rm(d, { recursive: true, force: true });
    });

    const run = (id: string, extra: Partial<PublishDeps> = {}) =>
      mediaPublishJob({ db: p.worker, env: {}, quarantineDir: quarantine, originalsDir: originals, r2: c, ...extra })(
        { media_id: id },
        { signal },
      );
    const state = async (id: string) =>
      (await p.owner.query<{ state: string }>('SELECT state FROM media WHERE id = $1', [id])).rows[0]?.state;
    const onBucket = async (ph: Pending) => (await listKeys(c)).filter((k) => ph.keys.includes(k));
    const expectUntouched = async (ph: Pending) => {
      expect(await onBucket(ph)).toEqual([]);
      expect(existsSync(join(originals, ph.id))).toBe(false);
      expect(existsSync(join(originals, `${ph.id}.tmp`))).toBe(false);
      expect(await state(ph.id)).toBe('pending_review');
      expect(existsSync(join(quarantine, ph.id, 'upload'))).toBe(true);
    };

    it('publishes a trusted member’s attached photo: every variant with its headers, the original, approved', async () => {
      const ph = await pendingPhoto(p, quarantine);
      await run(ph.id);
      expect(await onBucket(ph)).toEqual([...ph.keys].sort());
      for (const key of ph.keys) {
        expect(key).toMatch(KEY);
        for (const leak of [ph.userId, ph.id, ph.userId.replaceAll('-', ''), ph.id.replaceAll('-', ''), 'upload'])
          expect(key).not.toContain(leak);
        const head = await c.send({ method: 'HEAD', key });
        expect(head.status).toBe(200);
        expect(head.headers.get('content-type')).toBe(key.endsWith('.avif') ? 'image/avif' : 'image/webp');
        expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      }
      const row = (
        await p.owner.query<{ state: string; decided_at: Date | null }>(
          'SELECT state, decided_at FROM media WHERE id = $1',
          [ph.id],
        )
      ).rows[0];
      expect(row?.state).toBe('approved');
      expect(row?.decided_at).toBeInstanceOf(Date);
      expect((await readFile(join(originals, ph.id))).equals(ph.original)).toBe(true);
      expect(await readdir(originals)).not.toContain(`${ph.id}.tmp`);
      expect(existsSync(join(quarantine, ph.id))).toBe(false);
      // A second run is a no-op.
      await run(ph.id);
      expect(await state(ph.id)).toBe('approved');
      expect(await onBucket(ph)).toHaveLength(ph.keys.length);
    });

    it('an untrusted member’s photo and an unattached one are left alone', async () => {
      for (const ph of [
        await pendingPhoto(p, quarantine, { trusted: false }),
        await pendingPhoto(p, quarantine, { attached: false }),
      ]) {
        await run(ph.id);
        await expectUntouched(ph);
      }
    });

    it('trust revoked between the PUTs and the UPDATE: the keys and the original are deleted again', async () => {
      const ph = await pendingPhoto(p, quarantine);
      let seen: string[] = [];
      await run(ph.id, {
        beforeApprove: async () => {
          seen = await onBucket(ph);
          expect(existsSync(join(originals, ph.id))).toBe(true);
          await p.owner.query('UPDATE app_user SET trusted_at = NULL WHERE id = $1', [ph.userId]);
        },
      });
      expect(seen).toHaveLength(ph.keys.length);
      await expectUntouched(ph);
    });

    it('a banned member’s photo is left alone, before the PUTs and between them and the UPDATE (L3)', async () => {
      const before = await pendingPhoto(p, quarantine);
      await p.owner.query(`UPDATE app_user SET status = 'banned' WHERE id = $1`, [before.userId]);
      await run(before.id);
      await expectUntouched(before);
      const between = await pendingPhoto(p, quarantine);
      await run(between.id, {
        beforeApprove: async () => {
          await p.owner.query(`UPDATE app_user SET status = 'banned' WHERE id = $1`, [between.userId]);
        },
      });
      await expectUntouched(between);
    });

    it('a retry that finds trust revoked deletes what a run that died before its UPDATE put (L2)', async () => {
      const died = await pendingPhoto(p, quarantine);
      const img = await readFile(join(quarantine, died.id, 'v', '400.webp'));
      // The dead run: its PUTs and its original, then nothing.
      for (const key of died.keys) await c.put(key, img, { contentType: 'image/webp', cacheControl: 'no-store' });
      await writeFile(join(originals, died.id), died.original);
      await p.owner.query('UPDATE app_user SET trusted_at = NULL WHERE id = $1', [died.userId]);
      // Without an earlier run there is nothing to undo: the stray keys stay (no run of ours put them).
      await run(died.id);
      expect(await onBucket(died)).toHaveLength(died.keys.length);
      // The retry: the running job's second attempt.
      await p.owner.query(
        `INSERT INTO job (kind, state, attempts, payload) VALUES ('media_publish', 'running', 2, $1)`,
        [JSON.stringify({ media_id: died.id })],
      );
      await run(died.id);
      await expectUntouched(died);
      await run(died.id); // idempotent: the 404s are fine
      await expectUntouched(died);
    });

    it('a failure part-way leaves nothing; the retry publishes; a leftover temp original is replaced', async () => {
      const ph = await pendingPhoto(p, quarantine);
      let puts = 0;
      server.use(
        http.put(`${origin}/*`, () => (++puts === 3 ? new HttpResponse(null, { status: 503 }) : passthrough())),
      );
      await expect(run(ph.id)).rejects.toMatchObject({ code: 'store_unavailable', retry: true });
      server.resetHandlers();
      real();
      await expectUntouched(ph);
      await writeFile(join(originals, `${ph.id}.tmp`), 'left over');
      await run(ph.id);
      expect(await state(ph.id)).toBe('approved');
      expect(await onBucket(ph)).toHaveLength(ph.keys.length);
      expect((await readFile(join(originals, ph.id))).equals(ph.original)).toBe(true);
      expect(existsSync(join(originals, `${ph.id}.tmp`))).toBe(false);
    });

    it('a planted link or a file that is not its format never reaches the bucket', async () => {
      const outside = join(await mkdtemp(join(tmpdir(), 'mjk-secret-')), 'secret');
      await writeFile(outside, randomBytes(64));
      const link = await pendingPhoto(p, quarantine);
      const variant = join(quarantine, link.id, 'v', '400.webp');
      await rm(variant);
      await symlink(outside, variant);
      const swapped = await pendingPhoto(p, quarantine);
      const avif = await readFile(join(quarantine, swapped.id, 'v', '400.avif'));
      const webp = join(quarantine, swapped.id, 'v', '400.webp');
      // An AVIF named .webp, padded to the row's size: only the magic check catches it.
      const size = (await readFile(webp)).length;
      await writeFile(webp, Buffer.concat([avif, Buffer.alloc(Math.max(0, size - avif.length))]).subarray(0, size));
      const dirLink = await pendingPhoto(p, quarantine);
      await rm(join(quarantine, dirLink.id, 'v'), { recursive: true });
      await symlink(join(quarantine, link.id, 'v'), join(quarantine, dirLink.id, 'v'));
      for (const ph of [link, swapped, dirLink]) {
        await expect(run(ph.id)).rejects.toMatchObject({ code: 'media_variant_invalid', retry: false });
        await expectUntouched(ph);
      }
    });

    it('a variant with metadata or of the wrong size never reaches the bucket (security review M2)', async () => {
      const img = (h: number) => sharp({ create: { width: 400, height: h, channels: 3, background: '#336699' } });
      for (const bytes of [
        await img(300)
          .webp()
          .withExif({ IFD0: { Copyright: 'MJKEXIF' } })
          .toBuffer(),
        await img(200).webp().toBuffer(),
      ]) {
        const ph = await pendingPhoto(p, quarantine);
        await writeFile(join(quarantine, ph.id, 'v', '400.webp'), bytes);
        await p.owner.query(
          `UPDATE media_variant SET bytes = $2 WHERE media_id = $1 AND format = 'webp' AND width = 400`,
          [ph.id, bytes.length],
        );
        await expect(run(ph.id)).rejects.toMatchObject({ code: 'media_variant_invalid', retry: false });
        await expectUntouched(ph);
      }
    });

    it('rejects a payload that is not exactly {media_id}', async () => {
      for (const bad of [{}, { media_id: 'x' }, { media_id: randomBytes(16).toString('hex') }, { media_id: '', a: 1 }])
        await expect(mediaPublishJob({ db: p.worker, env: {}, r2: c })(bad, { signal })).rejects.toMatchObject({
          code: 'media_bad_payload',
          retry: false,
        });
    });

    describe('restic (criterion 9)', () => {
      const bucket = `mjk-pub-bk-${process.pid}-${randomBytes(3).toString('hex')}`;
      let secretsDir: string;
      let resticOpts: { env: Record<string, string> };
      const resticBin = process.env.MJK_TEST_RESTIC ?? 'restic';
      const restic = async (...args: string[]) =>
        (await exec(resticBin, args, { ...resticOpts, maxBuffer: 16 * 1024 * 1024 })).stdout;
      const snapshotPaths = async () => {
        const snaps = JSON.parse(await restic('--no-cache', 'snapshots', '--json')) as { id: string }[];
        const out: string[][] = [];
        for (const s of snaps) out.push((await restic('--no-cache', 'ls', s.id)).split('\n'));
        return out;
      };

      beforeAll(async () => {
        secretsDir = await mkdtemp(join(tmpdir(), 'mjk-pub-secrets-'));
        await writeFile(join(secretsDir, 'restic_password'), `${randomBytes(18).toString('base64url')}\n`);
        await writeFile(
          join(secretsDir, 'r2_backup_put'),
          `[default]\naws_access_key_id=${process.env.MJK_TEST_MINIO_ACCESS_KEY}\naws_secret_access_key=${process.env.MJK_TEST_MINIO_SECRET_KEY}\n`,
        );
        const cfg = parseBackupConfig({
          MJK_R2_ENDPOINT: minioUrl,
          MJK_R2_BUCKET_BACKUP: bucket,
          MJK_R2_REGION: 'us-east-1',
        });
        if (!cfg.ok) throw new Error(cfg.code);
        resticOpts = { env: resticEnv(cfg.config, secretsDir) };
        await restic('--no-cache', '--quiet', 'init');
      }, 120_000);
      afterAll(async () => {
        if (secretsDir !== undefined) await rm(secretsDir, { recursive: true, force: true });
      });

      it('a pending photo’s original is in no snapshot; a published one’s is in the next', async () => {
        const pending = await pendingPhoto(p, quarantine, { trusted: false });
        const published = await pendingPhoto(p, quarantine);
        await restic(...resticBackupArgs([originals]));
        expect((await snapshotPaths()).flat()).not.toContain(join(originals, published.id));
        await run(pending.id);
        await run(published.id);
        await restic(...resticBackupArgs([originals]));
        const snaps = await snapshotPaths();
        expect(snaps).toHaveLength(2);
        expect(snaps.at(-1)).toContain(join(originals, published.id));
        for (const files of snaps) {
          expect(files).not.toContain(join(originals, pending.id));
          expect(files.join('\n')).not.toContain(pending.id);
        }
      }, 120_000);
    });
  });
}
