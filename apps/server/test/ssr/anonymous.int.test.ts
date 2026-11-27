import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { recomputeStats } from '../../src/reviews/stats-job.ts';
import { createSsrApp } from '../../src/ssr/app.ts';
import { loadBundle } from '../../src/ssr/bundle.ts';
import { inProcessApi } from '../../src/ssr/server.ts';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { addReview } from '../reviews/fixtures.ts';
import type { SeededCatalogue } from '../seed-catalogue.ts';

// P1c criterion 5 straight against ssr: a response never depends on the cookie, the session, the
// Host, the language or the client address, and ssr never sets a cookie. P3a: the same for the pages that show
// scores and reviews (the museum, its reviews, one review, a profile), with a review fixture.

let p: PassportDb;
let cat: SeededCatalogue;
let reviewId: string;
let handle: string;
let db: Db;
let app: ReturnType<typeof createSsrApp>;

beforeAll(async () => {
  p = await openPassportDb();
  cat = p.catalogue;
  // Two members rate the Rijksmuseum, one with a hostile body; the stats job (as the worker) makes the scores.
  const museum = cat.named.rijksmuseum;
  const a = await p.newMember({ handle: 'anna_review' });
  handle = a.handle;
  reviewId = await addReview(p, {
    userId: a.id,
    museumId: museum.id,
    visitId: await p.addVisit(a.id, museum.id, { on: '2026-09-12' }),
    rating: 5,
    kid_friendly: 4,
    body: HOSTILE_BODY,
  });
  const b = await p.newMember();
  await addReview(p, {
    userId: b.id,
    museumId: museum.id,
    visitId: await p.addVisit(b.id, museum.id, { on: null }),
    rating: 4,
  });
  await recomputeStats(p.worker);
  const bundle = await loadBundle();
  if (typeof bundle === 'string') throw new Error(`the web build is ${bundle}`);
  const pool = createPool('mjk_ssr', { DATABASE_URL: p.tdb.urls.mjk_ssr }, { max: 4, statementTimeoutMs: 5000 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
  app = createSsrApp({
    bundle,
    fetchApi: inProcessApi(db, silentLogger),
    db,
    config: { brand: 'Musea Test', domain: 'mjk.test', controller: 'Test Beheerder', contactEmail: 'info@mjk.test' },
    logger: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await p?.close();
});

const HOSTILE_BODY = '</script><b>x</b> [x](y)\nTweede regel';
const SESSION = `__Host-mjk_sid=${'A'.repeat(43)}; theme=dark`;
const LOADED = {
  Cookie: SESSION,
  Authorization: 'Bearer x',
  Host: 'evil.example',
  'Accept-Language': 'en',
  'X-Forwarded-For': '203.0.113.9',
};

const headersOf = (r: Response) => [...r.headers].sort(([a], [b]) => a.localeCompare(b));

it('answers every page kind, error, redirect and static file the same with and without identity headers', async () => {
  const paths = [
    '/',
    '/en/',
    '/musea',
    '/en/museums?q=rijks&limit=5',
    `/musea/${cat.named.rijksmuseum.slug}`,
    `/en/museums/${cat.named.rijksmuseum.slug}`,
    '/provincie/noord-holland',
    '/zoeken?q=rijks',
    '/kaart',
    '/privacy',
    '/en/how-we-check-reviews',
    '/paspoort',
    '/en/sign-in',
    `/musea/${cat.named.renamed.oldSlugs[0]}`,
    // P3a: scores and reviews
    `/musea/${cat.named.rijksmuseum.slug}/reviews`,
    `/en/museums/${cat.named.rijksmuseum.slug}/reviews`,
    `/musea/${cat.named.renamed.oldSlugs[0]}/reviews`,
    `/musea/${cat.named.renamed.slug}/reviews`,
    `/reviews/${reviewId}`,
    `/en/reviews/${reviewId}`,
    '/reviews/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    '/reviews/not-a-uuid',
    `/musea/${cat.named.rijksmuseum.slug}/reviews/x`,
    `/u/${handle}`,
    `/en/u/${handle}`,
    '/musea?min_rating=4&kid_friendly=true',
    '/kaart?min_rating=3',
    '/musea/bestaat-niet',
    '/nergens',
    '/musea?province=NL-XX',
    '/sitemap.xml',
    '/robots.txt',
  ];
  for (const path of paths) {
    const plain = await app.request(`http://mjk.test${path}`);
    const loaded = await app.request(`http://mjk.test${path}`, { headers: LOADED });
    expect(loaded.status, path).toBe(plain.status);
    expect(headersOf(loaded), path).toEqual(headersOf(plain));
    expect(plain.headers.get('set-cookie'), path).toBeNull();
    expect(loaded.headers.get('set-cookie'), path).toBeNull();
    expect(plain.headers.get('x-request-id'), path).toBeNull();
    const a = Buffer.from(await plain.arrayBuffer());
    const b = Buffer.from(await loaded.arrayBuffer());
    expect(b.equals(a), path).toBe(true);
  }
});

it('renders the review fixture on every review page, one review page per review, and a 301 for an old slug', async () => {
  const get = (path: string) => app.request(`http://mjk.test${path}`);
  const slug = cat.named.rijksmuseum.slug;

  const museum = await (await get(`/musea/${slug}`)).text();
  expect(museum).toContain('4,5 van 5'); // the shown mean of 5 and 4
  expect(museum).toContain('2 beoordelingen');
  expect(museum).toContain(`href="/musea/${slug}/reviews"`);
  expect(/"aggregateRating":\{[^}]*"ratingValue":4\.5[^}]*"ratingCount":2/.test(museum)).toBe(true);

  const list = await get(`/musea/${slug}/reviews`);
  expect(list.status).toBe(200);
  const listHtml = await list.text();
  expect(listHtml.match(/class="review-card/g)).toHaveLength(2);
  expect(listHtml).toContain('&lt;/script&gt;&lt;b&gt;x&lt;/b&gt; [x](y)\nTweede regel');
  expect(listHtml).not.toContain('<meta name="robots"'); // indexable
  expect(listHtml).toContain(`<link rel="canonical" href="https://mjk.test/musea/${slug}/reviews"/>`);

  const one = await get(`/en/reviews/${reviewId}`);
  expect(one.status).toBe(200);
  const oneHtml = await one.text();
  expect(oneHtml).toContain('<meta name="robots" content="noindex, follow"/>');
  expect(oneHtml).toContain('Visited on 12 September 2026');
  const undated = await (await get(`/musea/${slug}/reviews`)).text();
  expect(undated).toMatch(/Bezocht(<!-- -->)? · /); // the second review has no visit date (N2)

  const profile = await (await get(`/u/${handle}`)).text();
  expect(profile).toContain('id="profile-reviews"');

  const moved = await get(`/musea/${cat.named.renamed.oldSlugs[0]}/reviews`);
  expect(moved.status).toBe(301);
  expect(moved.headers.get('location')).toBe(`/musea/${cat.named.renamed.slug}/reviews`);
  expect((await get('/reviews/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b')).status).toBe(404);
  expect((await get('/reviews/not-a-uuid')).status).toBe(404);
  expect((await get(`/musea/${slug}/reviews/x`)).status).toBe(404);
  expect((await get('/musea/bestaat-niet/reviews')).status).toBe(404);

  const sitemap = await (await get('/sitemap.xml')).text();
  expect(sitemap).toContain(`<loc>https://mjk.test/musea/${slug}/reviews</loc>`);
  expect(sitemap).toContain(`<loc>https://mjk.test/en/museums/${slug}/reviews</loc>`);
  // A museum without a rating has no review page in the sitemap; no single review is listed.
  expect(sitemap.match(/\/reviews<\/loc>/g)).toHaveLength(2);
  expect(sitemap).not.toContain(`/reviews/${reviewId}`);
});
