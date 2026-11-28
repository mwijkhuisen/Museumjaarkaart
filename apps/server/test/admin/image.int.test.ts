import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Harness, openHarness } from './harness.ts';

// `admin museum image hide|unhide` as mjk_api (no R2 key): the state moves, `commons_image` is queued for the worker,
// one audit row holds codes only.

let h: Harness;
let owner: pg.Client;
let id: string;
let other: string;
beforeAll(async () => {
  h = await openHarness();
  owner = new pg.Client({ connectionString: h.db.urls.mjk_migrator });
  await owner.connect();
  [id, other] = (await h.seed([
    { slug: 'with-image', name: 'With image' },
    { slug: 'no-image', name: 'No image' },
  ])) as [string, string];
  await owner.query(
    `INSERT INTO museum_image (museum_id, file, sha1, licence, attribution, public_key, width, height, widths, state)
     VALUES ($1, 'A secret file name.jpg', $2, 'cc-by-sa-4.0', 'Jane Doe', $3, 1920, 1280, '{640,1280}', 'active')`,
    [id, 'a'.repeat(40), 'b'.repeat(32)],
  );
});
afterAll(async () => {
  await owner?.end();
  await h?.close();
});

const state = async () =>
  (await owner.query<{ state: string }>('SELECT state FROM museum_image WHERE museum_id = $1', [id])).rows[0]?.state;
const jobs = async () => (await owner.query("SELECT payload FROM job WHERE kind = 'commons_image'")).rows;
const audits = async () =>
  (
    await owner.query<{ j: string }>(
      "SELECT row_to_json(a)::text AS j FROM audit_log a WHERE action LIKE 'museum.image%'",
    )
  ).rows;
const visible = async () => (await owner.query('SELECT 1 FROM pub_museum_image')).rowCount;

it('hide drops the image from the public view at once and queues the worker', async () => {
  expect(await visible()).toBe(1);
  expect(await h.admin('museum', 'image', 'hide', 'with-image')).toEqual({
    code: 0,
    out: ['with-image (With image): image hidden'],
    err: [],
  });
  expect(await state()).toBe('hidden');
  expect(await visible()).toBe(0);
  expect(await jobs()).toEqual([{ payload: { museum_id: id } }]);
  const rows = await audits();
  expect(rows).toHaveLength(1);
  expect(JSON.parse((rows[0] as { j: string }).j)).toMatchObject({
    actor_kind: 'admin',
    action: 'museum.image_hide',
    target_kind: 'museum',
    target_id: id,
    detail: {},
  });
  for (const leak of ['secret', 'Jane', 'bbbb']) expect((rows[0] as { j: string }).j).not.toContain(leak);
});

it('hiding again changes nothing', async () => {
  expect(await h.admin('museum', 'image', 'hide', 'with-image')).toEqual({
    code: 0,
    out: ['with-image (With image): image no change'],
    err: [],
  });
  expect(await jobs()).toHaveLength(1);
  expect(await audits()).toHaveLength(1);
});

it('unhide waits for the worker to give the row its code, then sets it skipped and queues again', async () => {
  // The worker has not removed the objects yet: a `skipped` row needs its skip_code.
  expect(await h.admin('museum', 'image', 'unhide', 'with-image')).toEqual({
    code: 65,
    out: [],
    err: ['admin: hide_not_processed_yet'],
  });
  expect(await state()).toBe('hidden');
  await owner.query(
    "UPDATE museum_image SET public_key = NULL, widths = NULL, width = NULL, height = NULL, skip_code = 'commons_hidden' WHERE museum_id = $1",
    [id],
  );
  expect((await h.admin('museum', 'image', 'unhide', 'with-image')).code).toBe(0);
  expect(await state()).toBe('skipped');
  expect(await visible()).toBe(0);
  expect(await jobs()).toHaveLength(2);
  expect((await audits()).map((r) => JSON.parse(r.j).action)).toEqual(['museum.image_hide', 'museum.image_unhide']);
});

it('a museum without an image row, an unknown museum and bad usage', async () => {
  expect(await h.admin('museum', 'image', 'hide', 'no-image')).toEqual({
    code: 66,
    out: [],
    err: ['admin: image_not_found'],
  });
  expect((await h.admin('museum', 'image', 'hide', 'nowhere')).code).toBe(66);
  expect((await h.admin('museum', 'image', 'delete', 'with-image')).code).toBe(64);
  expect((await h.admin('museum', 'image', 'hide')).code).toBe(64);
  expect(other).toBeDefined();
  expect(await audits()).toHaveLength(2);
});
