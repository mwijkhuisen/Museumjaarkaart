import { crc32, createDeflate, deflateSync } from 'node:zlib';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { mailbox, museumPath, t } from './helpers.ts';

// P3b WP7 (the photo screens), end to end in each engine with its own seeded members (seed-e2e.ts, the P3b block;
// each has a dated visit to both museums below and no review). One member per test, so no address signs in twice:
//   - `photo_<engine>`: trusted by stack.sh (`admin user trust`). The photo waits "wacht op controle" until the
//     review is saved, then the worker publishes it and the reviews page loads it from media.<domain> (MinIO).
//   - `photo_pending_<engine>`: untrusted. The photo stays pending: the author sees the server preview, the public
//     API and page show no photo.
//   - `photo_bomb_<engine>`: uploads a 30,000 x 30,000 PNG. It ends `failed` and the UI says so; stack.sh then checks
//     that the media role neither restarted nor was OOM-killed (criterion 3).
// The guard of fixtures.ts covers the CSP, the hosts and the console on every page.

// The two museums seed-e2e.ts picks from the deterministic test catalogue (`seed-e2e: photo plain=… forbidden=…`).
const FORBIDDEN = 'scheepvaartmuseum-bergen-op-zoom'; // photo_policy forbidden: the form warns and still allows (Q4)
const ALLOWED = 'beeldhouwkunstmuseum-woerden'; // photo_policy allowed: no note

/** A PNG of 8-bit greyscale whose IDAT is the given, already deflated, data. */
const png = (width: number, height: number, idat: Buffer): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grey), the rest zero
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** A real 1200 x 800 photo: a gradient per row, filter 0. A few KB. */
const photo = (): Buffer =>
  png(
    1200,
    800,
    deflateSync(
      Buffer.concat(
        Array.from({ length: 800 }, (_, y) =>
          Buffer.concat([Buffer.from([0]), Buffer.alloc(1200, Math.floor((y * 255) / 800))]),
        ),
      ),
    ),
  );

/**
 * The decompression bomb: 30,000 x 30,000 8-bit grey is 900 MB decoded. Every raw row is a filter byte and 30,000
 * zero bytes. deflate's best ratio is about 1000:1, so the file is under 1 MB (not a few hundred bytes); the rows are
 * streamed through one shared buffer so the runner never holds the 900 MB.
 */
const bomb = async (): Promise<Buffer> => {
  const row = Buffer.alloc(30_001);
  const idat = await new Promise<Buffer>((resolve, reject) => {
    const deflate = createDeflate({ level: 9 });
    const parts: Buffer[] = [];
    deflate.on('data', (c: Buffer) => parts.push(c));
    deflate.on('end', () => resolve(Buffer.concat(parts)));
    deflate.on('error', reject);
    for (let y = 0; y < 30_000; y++) deflate.write(row);
    deflate.end();
  });
  return png(30_000, 30_000, idat);
};

async function signIn(page: Page, request: APIRequestContext, email: string, name: string, handle: string) {
  await page.goto('/inloggen');
  const byCode = page.getByRole('region', { name: t('auth_code_heading') });
  await byCode.getByLabel(t('field_email')).fill(email);
  const send = byCode.getByRole('button', { name: t('action_send_code') });
  await expect(send).toBeEnabled({ timeout: 30_000 }); // the ALTCHA proof of work has solved
  await send.click();
  await page.getByLabel(t('field_code')).fill(await mailbox(request, email).code());
  await page.getByRole('button', { name: t('action_verify'), exact: true }).click();
  await expect(
    page.getByText(t('account_signed_in_as').replace('{name}', name).replace('{handle}', handle)),
  ).toBeVisible();
}

/** Opens the review form of a museum the member has a visit to. */
async function openForm(page: Page, slug: string) {
  await page.goto(museumPath('nl', slug));
  const name = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
  await page.getByRole('button', { name: t('review_mine_prompt').replace('{name}', name) }).click();
  const form = page.locator('form.review-form');
  await expect(form).toBeVisible();
  return form;
}

const tickConsents = async (form: ReturnType<Page['locator']>) => {
  const file = form.getByLabel(t('photo_file'));
  await expect(file).toBeDisabled(); // nothing can be chosen before the consents
  await form.getByLabel(t('photo_consent_own')).check();
  await form.getByLabel(t('photo_consent_people')).check();
  await expect(file).toBeDisabled(); // two of three is not enough
  await form.getByLabel(t('photo_consent_artwork')).check();
  await expect(file).toBeEnabled();
  return file;
};

const stars = (n: number) => t('review_form_stars').replace('{n}', String(n));

type ApiReview = { id: string; author: { handle: string }; photos: { public_key: string; widths: number[] }[] };
const reviewsOf = async (request: APIRequestContext, slug: string): Promise<ApiReview[]> =>
  ((await (await request.get(`/api/v1/museums/${slug}/reviews?limit=50`)).json()) as { items: ApiReview[] }).items;

// The browser logs the failed preview or the 4xx of a rejected upload as a failed resource.
test.use({ allowedConsole: [/status of 4\d\d/] });

test('@photos a trusted member`s photo is published and loads from the media origin', async ({
  page,
  request,
  browserName,
}) => {
  test.slow();
  const handle = `photo_${browserName}`;
  await signIn(page, request, `photo-${browserName}@mjk.test`, `E2E ${handle}`, handle);
  const form = await openForm(page, FORBIDDEN);

  // The house rule of a museum that forbids photography is a prominent warning, and the upload is still allowed.
  await expect(form.getByRole('note').filter({ hasText: t('photo_policy_forbidden') })).toBeVisible();
  const file = await tickConsents(form);

  // Type and size are refused before any request.
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/uploads')) uploads.push(r.url());
  });
  await file.setInputFiles({ name: 'camera.heic', mimeType: 'image/heic', buffer: Buffer.from('x') });
  await expect(form.getByRole('alert').filter({ hasText: t('photo_err_type') })).toBeVisible();
  await file.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(form.getByRole('alert').filter({ hasText: t('photo_err_size') })).toBeVisible();
  expect(uploads).toEqual([]);

  await file.setInputFiles({ name: 'zaal.png', mimeType: 'image/png', buffer: photo() });
  // Unattached, the photo is processed and waits: the author's preview comes from the server, never a blob: URL.
  const item = form.locator('.photo-list li');
  await expect(item.getByText(t('photo_pending'))).toBeVisible({ timeout: 60_000 });
  const preview = item.locator('img');
  await expect(preview).toHaveAttribute('src', /^\/api\/v1\/uploads\/[0-9a-f-]{36}\/preview\?w=400$/);
  await expect.poll(() => preview.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

  // A description of its own, saved with the button.
  await item.getByLabel(t('photo_alt_label')).fill('Een zaal vol licht');
  await item.getByRole('button', { name: t('photo_alt_save') }).click();
  await expect(item.getByText(t('photo_alt_saved'))).toBeVisible();

  await form
    .getByRole('group', { name: t('review_form_rating') })
    .getByLabel(stars(4))
    .check();
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/reviews'));
  await form.getByRole('button', { name: t('action_save'), exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(form).toHaveCount(0);

  // The worker publishes the photo of a trusted author once the review holds it.
  await expect
    .poll(async () => (await reviewsOf(request, FORBIDDEN)).find((r) => r.author.handle === handle)?.photos.length, {
      timeout: 60_000,
    })
    .toBe(1);
  const mine = (await reviewsOf(request, FORBIDDEN)).find((r) => r.author.handle === handle);
  const key = mine?.photos[0]?.public_key ?? '';
  expect(key).toMatch(/^[0-9a-f]{32}$/);

  // This member's own photo: the other engine's trusted member reviews the same museum, so the page holds two.
  const media = page.waitForResponse((r) =>
    new RegExp(`^https://media\\.mjk\\.test/p/${key}/\\d+\\.(avif|webp)$`).test(r.url()),
  );
  await page.goto(`${museumPath('nl', FORBIDDEN)}/reviews`);
  const card = page.locator('.review-card').filter({ hasText: `E2E ${handle}` });
  const img = card.locator('picture img');
  await img.scrollIntoViewIfNeeded();
  const answer = await media;
  expect(answer.status()).toBe(200);
  expect(answer.url()).toContain(`/p/${key}/`);
  await expect(img).toHaveAttribute('src', new RegExp(`^https://media\\.mjk\\.test/p/${key}/\\d+\\.webp$`));
  await expect(img).toHaveAttribute('alt', 'Een zaal vol licht');
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
});

test('@photos an untrusted member`s photo waits for review: the author sees a preview, the public sees nothing', async ({
  page,
  request,
  browserName,
}) => {
  test.slow();
  const handle = `photo_pending_${browserName}`;
  await signIn(page, request, `photo-pending-${browserName}@mjk.test`, `E2E ${handle}`, handle);
  const form = await openForm(page, ALLOWED);
  await expect(form.locator('.photo-warning')).toHaveCount(0); // an allowed museum shows no note
  const file = await tickConsents(form);
  await file.setInputFiles({ name: 'zaal.png', mimeType: 'image/png', buffer: photo() });
  const item = form.locator('.photo-list li');
  await expect(item.getByText(t('photo_pending'))).toBeVisible({ timeout: 60_000 });
  await form
    .getByRole('group', { name: t('review_form_rating') })
    .getByLabel(stars(3))
    .check();
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/reviews'));
  await form.getByRole('button', { name: t('action_save'), exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(form).toHaveCount(0);

  // On their own review the author still sees the photo, labelled, from the preview route.
  const mine = page.getByRole('region', { name: t('review_mine_h') });
  await expect(mine.getByText(t('photo_pending'))).toBeVisible();
  await expect(mine.locator('img')).toHaveAttribute('src', /\/api\/v1\/uploads\/[0-9a-f-]{36}\/preview\?w=400$/);

  // The public sees the review without it: the API, and the page.
  const review = (await reviewsOf(request, ALLOWED)).find((r) => r.author.handle === handle);
  expect(review).toBeDefined();
  expect(review?.photos).toEqual([]);
  const anonymous = await request.get(`${museumPath('nl', ALLOWED)}/reviews`);
  expect(await anonymous.text()).not.toContain('/p/');
});

test('@photos a decompression bomb ends failed and the screen says so, nothing else breaks', async ({
  page,
  request,
  browserName,
}) => {
  test.slow();
  const data = await bomb();
  expect(data.length).toBeLessThan(2_000_000); // ~1 MB for 900 MB of pixels (deflate's best ratio is ~1000:1)
  const handle = `photo_bomb_${browserName}`;
  await signIn(page, request, `photo-bomb-${browserName}@mjk.test`, `E2E ${handle}`, handle);
  const form = await openForm(page, ALLOWED);
  const file = await tickConsents(form);
  await file.setInputFiles({ name: 'bom.png', mimeType: 'image/png', buffer: data });
  await expect(form.getByRole('alert').filter({ hasText: t('photo_err_failed') })).toBeVisible({ timeout: 90_000 });
  // The site still answers.
  expect((await request.get('/api/v1/healthz')).ok()).toBe(true);
});
