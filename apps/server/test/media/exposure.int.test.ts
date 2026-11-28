import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GalleryPhoto, OwnReview, PhotoList, PublicReview, ReviewList } from '@mjk/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { variantsDir } from '../../src/media/files.ts';
import { pickWidth } from '../../src/media/preview.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { openMuseum } from '../reviews/app.ts';
import { openPhotos, type PhotosFixture, webp } from './photos.ts';

// P3b criterion 9 (the api, ssr, `pub_media` and preview parts): a photo that waits for review (or was rejected
// or removed) is never public. One review with an approved photo, a pending one, a rejected one and a removed
// one that still carries a public key; every public answer, the ssr's in-process answers, the view as mjk_ssr
// and the server-rendered pages hold the approved photo and none of the others.

let f: PhotosFixture;
let ssrDb: Db;
let ssrPages: ReturnType<typeof createSsrApp>;
const S = {} as {
  museum: { id: string; slug: string };
  author: Awaited<ReturnType<PhotosFixture['member']>>;
  other: Awaited<ReturnType<PhotosFixture['member']>>;
  reviewId: string;
  approved: { id: string; publicKey: string };
  pending: { id: string; publicKey: string };
  hidden: { id: string; publicKey: string }[];
};

beforeAll(async () => {
  f = await openPhotos();
  S.museum = await openMuseum(f.p, 300);
  S.author = await f.member(S.museum.id);
  S.other = await f.member(S.museum.id);
  S.reviewId = await f.review(S.author.id, S.museum.id, S.author.visitId);
  const base = { userId: S.author.id, museumId: S.museum.id, reviewId: S.reviewId };
  S.approved = await f.photo({
    ...base,
    state: 'approved',
    alt: 'Een zaal met schilderijen',
    widths: [400, 1200, 1600],
  });
  S.pending = await f.photo({ ...base, state: 'pending_review', variants: [400, 1200] });
  S.hidden = [
    await f.photo({ ...base, state: 'rejected' }),
    await f.photo({ ...base, state: 'removed' }),
    await f.photo({ ...base, state: 'failed' }),
    await f.photo({ ...base, state: 'quarantined' }),
    await f.photo({ ...base, state: 'processing' }),
  ];
  const bundle = await loadBundle();
  if (typeof bundle === 'string') throw new Error(`the web build is ${bundle}`);
  ssrDb = createDb(f.p.pools.ssr);
  ssrPages = createSsrApp({
    bundle,
    fetchApi: inProcessApi(ssrDb, silentLogger),
    db: ssrDb,
    config: { brand: 'Musea Test', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' },
    logger: silentLogger,
  });
}, 180_000);

afterAll(async () => {
  await f?.close();
});

const secrets = () => [S.pending, ...S.hidden].flatMap((x) => [x.id, x.publicKey]);
const leak = (text: string, what: string) => {
  for (const s of secrets()) expect(text, `${what} holds ${s}`).not.toContain(s);
};

describe('the public answers', () => {
  const paths = () => [
    `/reviews/${S.reviewId}`,
    `/museums/${S.museum.slug}/reviews`,
    `/museums/${S.museum.slug}/photos`,
    `/users/${S.author.handle}/reviews`,
    `/users/${S.author.handle}/photos`,
  ];

  it('hold the approved photo and no other, as the api and as the ssr’s in-process app', async () => {
    for (const path of paths()) {
      const viaApi = await f.t.call(path);
      expect(viaApi.status, path).toBe(200);
      const text = await viaApi.text();
      leak(text, `api ${path}`);
      expect(text, path).toContain(S.approved.id);
      expect(text, path).toContain(S.approved.publicKey);
      const viaSsr = await f.ssrGet(path);
      expect(viaSsr.status, path).toBe(200);
      expect(await viaSsr.text(), path).toBe(text);
    }
  });

  it('give the review exactly one photo, with the AVIF widths, and the lists the same one', async () => {
    const review = PublicReview.parse(await (await f.t.call(`/reviews/${S.reviewId}`)).json());
    expect(review.photos).toEqual([
      {
        id: S.approved.id,
        width: expect.any(Number),
        height: expect.any(Number),
        alt_text: 'Een zaal met schilderijen',
        public_key: S.approved.publicKey,
        widths: [400, 1200, 1600],
      },
    ]);
    const list = ReviewList.parse(await (await f.t.call(`/museums/${S.museum.slug}/reviews`)).json());
    expect(list.items.map((r) => r.photos.map((x) => x.id))).toEqual([[S.approved.id]]);
    const gallery = PhotoList.parse(await (await f.t.call(`/users/${S.author.handle}/photos`)).json());
    expect(gallery.items).toHaveLength(1);
    expect(GalleryPhoto.parse(gallery.items[0])).toMatchObject({
      id: S.approved.id,
      review_id: S.reviewId,
      author_handle: S.author.handle,
      museum: { slug: S.museum.slug },
    });
  });

  it('hold nothing of a photo whose review is removed', async () => {
    const m = await openMuseum(f.p, 301);
    const u = await f.member(m.id);
    const rid = await f.review(u.id, m.id, u.visitId);
    const ph = await f.photo({ userId: u.id, museumId: m.id, reviewId: rid, state: 'approved' });
    const gallery = `/museums/${m.slug}/photos`;
    expect((await (await f.t.call(gallery)).text()).includes(ph.id)).toBe(true);
    await f.p.owner.query("UPDATE review SET state = 'removed' WHERE id = $1", [rid]);
    expect(await (await f.t.call(gallery)).text()).not.toContain(ph.id);
    expect(await (await f.t.call(`/users/${u.handle}/photos`)).text()).not.toContain(ph.id);
    expect(await (await f.ssrGet(gallery)).text()).not.toContain(ph.id);
  });

  it('answer 404 for a hidden or unknown museum and an unknown handle, and 301 for an old slug', async () => {
    const hidden = await f.p.hidden();
    for (const path of [
      `/museums/${hidden.slug}/photos`,
      '/museums/bestaat-niet/photos',
      '/users/no_such_member/photos',
      '/users/Bad-Handle/photos',
    ]) {
      expect((await f.t.call(path)).status, path).toBe(404);
      expect((await f.ssrGet(path)).status, path).toBe(404);
    }
    const old = f.p.catalogue.named.renamed;
    const r = await f.t.call(`/museums/${old.oldSlugs[0]}/photos`);
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`/api/v1/museums/${old.slug}/photos`);
  });

  it('page by keyset, newest first, and refuse a cursor that is not an id cursor', async () => {
    const m = await openMuseum(f.p, 302);
    const u = await f.member(m.id);
    const rid = await f.review(u.id, m.id, u.visitId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await f.photo({ userId: u.id, museumId: m.id, reviewId: rid, state: 'approved' })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 5 && (n === 0 || cursor !== null); n++) {
      const q: string = `limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = PhotoList.parse(await (await f.t.call(`/museums/${m.slug}/photos?${q}`)).json());
      seen.push(...page.items.map((x) => x.id));
      cursor = page.next_cursor;
    }
    expect(seen).toEqual([...ids].reverse());
    const bad = await f.t.call(
      `/museums/${m.slug}/photos?cursor=${Buffer.from('{"m":"n","k":"a","i":"x"}').toString('base64url')}`,
    );
    expect(bad.status).toBe(400);
  });
});

describe('pub_media as mjk_ssr', () => {
  it('holds the approved photo and none of the others', async () => {
    const all = await f.p.pools.ssr.query<{ id: string; public_key: string }>(
      'SELECT id, public_key FROM pub_media WHERE museum_id = $1',
      [S.museum.id],
    );
    expect(all.rows.map((r) => r.id)).toEqual([S.approved.id]);
    for (const x of [S.pending, ...S.hidden]) {
      const r = await f.p.pools.ssr.query('SELECT 1 FROM pub_media WHERE id = $1 OR public_key = $2', [
        x.id,
        x.publicKey,
      ]);
      expect(r.rowCount, x.id).toBe(0);
    }
    // mjk_ssr reads no table: the photo's state and file never reach it.
    await expect(f.p.pools.ssr.query('SELECT state FROM media')).rejects.toThrow(/permission denied/);
  });
});

describe('the server-rendered pages', () => {
  const get = (path: string) => ssrPages.request(`http://mjk.test${path}`);

  it('hold no pending, rejected or removed photo, and the approved one where the page loads the reviews', async () => {
    const pages = [
      `/musea/${S.museum.slug}`,
      `/en/museums/${S.museum.slug}`,
      `/musea/${S.museum.slug}/reviews`,
      `/reviews/${S.reviewId}`,
      `/en/reviews/${S.reviewId}`,
      `/u/${S.author.handle}`,
    ];
    let approvedSeen = 0;
    for (const path of pages) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      const html = await r.text();
      leak(html, path);
      if (html.includes(S.approved.publicKey)) approvedSeen++;
    }
    // The reviews pages carry the review answer (and its photo) in the state block.
    expect(approvedSeen).toBeGreaterThanOrEqual(3);
  });
});

describe('GET /uploads/:id/preview', () => {
  const preview = (token: string | undefined, id: string, q = '') =>
    f.t.app.request(`http://localhost/api/v1/uploads/${id}/preview${q}`, {
      headers: {
        host: 'mjk.test',
        'Sec-Fetch-Site': 'same-origin',
        ...(token === undefined ? {} : { cookie: `__Host-mjk_sid=${token}` }),
      },
    });

  it('gives the author the WebP with exactly the four headers', async () => {
    const r = await preview(S.author.token, S.pending.id);
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.headers)).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(body.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(body.equals(await webp(400))).toBe(true);
    const big = Buffer.from(await (await preview(S.author.token, S.pending.id, '?w=1200')).arrayBuffer());
    expect(big.equals(await webp(1200))).toBe(true);
  });

  it('is a 404 for another member and for an anonymous request, with nothing of the photo', async () => {
    for (const token of [S.other.token, undefined, 'x'.repeat(43)]) {
      const r = await preview(token, S.pending.id);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not_found' });
      expect(r.headers.get('content-type')).toMatch(/json/);
    }
  });

  it('is a 404 for an approved, removed, failed, rejected, quarantined and processing photo, and for a malformed id', async () => {
    for (const id of [S.approved.id, ...S.hidden.map((x) => x.id), 'not-a-uuid', S.pending.id.toUpperCase()])
      expect((await preview(S.author.token, id)).status, id).toBe(404);
  });

  it('refuses a width that is not 400 or 1200, a repeated one and an unknown parameter', async () => {
    for (const q of ['?w=500', '?w=', '?w=400&w=1200', '?x=1', '?w=400.0'])
      expect((await preview(S.author.token, S.pending.id, q)).status, q).toBe(400);
  });

  it('picks the largest variant that fits, else the smallest', async () => {
    expect(pickWidth([320, 1200, 2000], 400)).toBe(320);
    expect(pickWidth([800, 1600], 400)).toBe(800);
    expect(pickWidth([400, 1200], 1200)).toBe(1200);
    expect(pickWidth([], 400)).toBeUndefined();
    const small = await f.photo({
      userId: S.author.id,
      museumId: S.museum.id,
      reviewId: null,
      state: 'pending_review',
      variants: [320, 800],
    });
    const r = await preview(S.author.token, small.id, '?w=1200');
    expect(Buffer.from(await r.arrayBuffer()).equals(await webp(800))).toBe(true);
    const tiny = Buffer.from(await (await preview(S.author.token, small.id)).arrayBuffer());
    expect(tiny.equals(await webp(320))).toBe(true);
  });

  it('is a 404 when the file is missing, a link, not a regular file or not a WebP', async () => {
    const mk = () => f.photo({ userId: S.author.id, museumId: S.museum.id, state: 'pending_review' });
    const none = await mk();
    expect((await preview(S.author.token, none.id)).status).toBe(404);

    const link = await mk();
    const dir = variantsDir(f.root, link.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(f.root, 'outside.webp'), await webp(400));
    await symlink(join(f.root, 'outside.webp'), join(dir, '400.webp'));
    expect((await preview(S.author.token, link.id)).status).toBe(404);

    const html = await mk();
    const hdir = variantsDir(f.root, html.id);
    await mkdir(hdir, { recursive: true });
    await writeFile(join(hdir, '400.webp'), '<html><script>alert(1)</script></html>');
    expect((await preview(S.author.token, html.id)).status).toBe(404);

    const jpegNamed = await mk();
    const jdir = variantsDir(f.root, jpegNamed.id);
    await mkdir(jdir, { recursive: true });
    await writeFile(join(jdir, '400.webp'), Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'));
    expect((await preview(S.author.token, jpegNamed.id)).status).toBe(404);

    const dirIsLink = await mk();
    await mkdir(join(f.root, dirIsLink.id), { recursive: true });
    await mkdir(join(f.root, 'elsewhere'), { recursive: true });
    await writeFile(join(f.root, 'elsewhere', '400.webp'), await webp(400));
    await symlink(join(f.root, 'elsewhere'), variantsDir(f.root, dirIsLink.id));
    expect((await preview(S.author.token, dirIsLink.id)).status).toBe(404);

    // A WebP that carries metadata, or is not the photo's size, is not sound either (security review M2).
    for (const bytes of [
      await sharp(await webp(400))
        .webp()
        .withExif({ IFD0: { Copyright: 'MJKEXIF' } })
        .toBuffer(),
      Buffer.concat([await webp(400), Buffer.from('MJKTAIL')]),
      await sharp({ create: { width: 400, height: 200, channels: 3, background: '#aa5533' } })
        .webp()
        .toBuffer(),
    ]) {
      const bad = await mk();
      const bdir = variantsDir(f.root, bad.id);
      await mkdir(bdir, { recursive: true });
      await writeFile(join(bdir, '400.webp'), bytes);
      expect((await preview(S.author.token, bad.id)).status).toBe(404);
    }
  });

  it('is a 404 once the photo is approved: the published URL is the only way to see it', async () => {
    const m = await f.photo({
      userId: S.author.id,
      museumId: S.museum.id,
      state: 'pending_review',
      variants: [400],
    });
    expect((await preview(S.author.token, m.id)).status).toBe(200);
    await f.p.owner.query("UPDATE media SET state = 'approved' WHERE id = $1", [m.id]);
    expect((await preview(S.author.token, m.id)).status).toBe(404);
  });
});

describe('the member’s own answers', () => {
  it('list the member’s own live photos, with a key only once approved, and never another member’s', async () => {
    // POST /reviews' answer shape: OwnReview with photos, built from the same reader.
    const m = await openMuseum(f.p, 303);
    const u = await f.member(m.id);
    const pre = await f.photo({ userId: u.id, museumId: m.id, state: 'pending_review', variants: [400] });
    const r = await f.t.call('/reviews', {
      token: u.token,
      body: { museum_id: m.id, visit_id: u.visitId, rating: 5, media_ids: [pre.id] },
    });
    expect(r.status).toBe(201);
    const own = OwnReview.parse(await r.json());
    expect(own.photos).toEqual([
      {
        id: pre.id,
        state: 'pending_review',
        width: expect.any(Number),
        height: expect.any(Number),
        alt_text: null,
        public_key: null,
        widths: [],
      },
    ]);
    expect(JSON.stringify(own)).not.toContain(pre.publicKey);
    // The public answers do not know it.
    leakOf(await (await f.t.call(`/reviews/${own.id}`)).text(), [pre.id, pre.publicKey]);
    leakOf(await (await f.t.call(`/museums/${m.slug}/photos`)).text(), [pre.id, pre.publicKey]);
  });
});

const leakOf = (text: string, needles: string[]) => {
  for (const n of needles) expect(text).not.toContain(n);
};

describe('the originals', () => {
  it('are named by no file under src/api or src/ssr', () => {
    const root = join(import.meta.dirname, '../../src');
    const hits: string[] = [];
    for (const dir of ['api', 'ssr'])
      for (const name of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }))
        if (
          name.endsWith('.ts') &&
          /ORIGINALS_DIR|\/srv\/mjk\/originals|originalsDir/.test(readFileSync(join(root, dir, name), 'utf8'))
        )
          hits.push(`${dir}/${name}`);
    expect(hits).toEqual([]);
  });
});
