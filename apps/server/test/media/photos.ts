import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp, type Mount, mountCatalogue } from '../../src/api/app.ts';
import { mountMedia } from '../../src/api/routes/media.ts';
import { createDb } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { variantsDir } from '../../src/media/files.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { mountReviewRoutes } from '../reviews/app.ts';
import { addReview } from '../reviews/fixtures.ts';

// P3b WP5's fixture: the review, public and media routes over meApp with a temp quarantine, the public reads as
// mjk_ssr (the ssr role's in-process app is buildApp + mountCatalogue), and owner-inserted photo rows with the
// variant files and rows the processing and publishing packages would make. Those packages are built in parallel
// and are not needed here.

export type PhotoState =
  | 'uploading'
  | 'quarantined'
  | 'processing'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'removed'
  | 'failed';

export type PhotosFixture = Awaited<ReturnType<typeof openPhotos>>;

const mountAll: Mount = (v1, d) => {
  mountReviewRoutes(v1, d);
  mountMedia(v1, d);
};

/** A small real WebP of this width. */
export const webp = (width: number): Promise<Buffer> =>
  sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: '#aa5533' } })
    .webp()
    .toBuffer();

export async function openPhotos(existing?: PassportDb) {
  const p = existing ?? (await openPassportDb());
  const root = await mkdtemp(join(tmpdir(), 'mjk-quarantine-'));
  const t = meApp(p, mountAll, { quarantineDir: root });
  const ssrApp = buildApp({ db: createDb(p.pools.ssr), logger: silentLogger, ping: async () => true }, mountCatalogue);
  const ssrGet = (path: string) => ssrApp.request(`http://localhost/api/v1${path}`);

  /** A member with a session and a visit to the museum. */
  async function member(museumId: string, opts: { trusted?: boolean; status?: string } = {}) {
    const u = await p.newMember(opts.status === undefined ? {} : { status: opts.status });
    if (opts.trusted === true) await p.owner.query('UPDATE app_user SET trusted_at = now() WHERE id = $1', [u.id]);
    return { ...u, token: await t.signIn(u.id), visitId: await p.addVisit(u.id, museumId) };
  }

  let seq = 0;
  /**
   * A photo row as the pipeline would leave it in `state`. `variants` (pending_review only) are the WebP widths
   * written into quarantine; an approved photo gets AVIF and WebP `media_variant` rows for `widths`.
   */
  async function photo(o: {
    userId: string;
    museumId: string;
    reviewId?: string | null;
    state: PhotoState;
    alt?: string | null;
    widths?: number[];
    variants?: number[];
  }) {
    const publicKey = randomBytes(16).toString('hex');
    const needsKey = o.state === 'pending_review' || o.state === 'approved' || o.state === 'removed';
    const needsSha = !['uploading', 'failed', 'removed'].includes(o.state);
    const r = await p.owner.query<{ id: string }>(
      `INSERT INTO media (user_id, museum_id, review_id, type, state, declared_size, chunk_count, sha256, width, height,
         public_key, alt_text, consents_at, error_code)
       VALUES ($1, $2, $3, 'image/jpeg', $4, 1000, 1, $5, $6, $7, $8, $9, now(), $10) RETURNING id`,
      [
        o.userId,
        o.museumId,
        o.reviewId ?? null,
        o.state,
        needsSha ? randomBytes(32) : null,
        needsKey ? 1600 + seq : null,
        // The 4:3 of `webp(width)`, which the preview's container check holds the variants to.
        needsKey ? Math.round((1600 + seq) * 0.75) : null,
        needsKey ? publicKey : null,
        o.alt ?? null,
        o.state === 'failed' ? 'process_failed' : null,
      ],
    );
    seq++;
    const id = (r.rows[0] as { id: string }).id;
    if (o.state === 'approved') {
      for (const w of o.widths ?? [400, 1200]) {
        for (const ext of ['avif', 'webp']) {
          await p.owner.query(
            'INSERT INTO media_variant (media_id, format, width, object_key, bytes) VALUES ($1, $2, $3, $4, 1000)',
            [id, ext, w, `p/${publicKey}/${w}.${ext}`],
          );
        }
      }
    }
    if (o.variants !== undefined) {
      const dir = variantsDir(root, id);
      await mkdir(dir, { recursive: true });
      for (const w of o.variants) await writeFile(join(dir, `${w}.webp`), await webp(w));
    }
    return { id, publicKey };
  }

  async function review(userId: string, museumId: string, visitId: string, rating = 4): Promise<string> {
    return addReview(p, { userId, museumId, visitId, rating });
  }

  const close = async () => {
    await rm(root, { recursive: true, force: true });
    if (existing === undefined) await p.close();
  };
  return { p, t, root, ssrGet, member, photo, review, close };
}
