import { OwnPhoto, PhotoList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMuseum } from '../reviews/app.ts';
import { openPhotos, type PhotosFixture } from './photos.ts';

// A§18: the authorization table of the photo routes. PATCH and DELETE /media/:id: anonymous, a session of the
// other host class, the owner, another member (404, never 403), a banned member's session (401) and a member
// who has not accepted the current terms (403 on PATCH; DELETE is allowed). The public photo lists answer the
// same with and without a cookie. The preview's own table is in exposure.int.test.ts.

let f: PhotosFixture;
let nth = 500;
const OLD_TERMS = '2020-01-01';
beforeAll(async () => {
  f = await openPhotos();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

async function scene(state: 'pending_review' | 'approved' | 'failed' | 'removed' = 'pending_review') {
  const museum = await openMuseum(f.p, nth++);
  const me = await f.member(museum.id);
  const other = await f.member(museum.id);
  const reviewId = await f.review(me.id, museum.id, me.visitId);
  const photo = await f.photo({ userId: me.id, museumId: museum.id, reviewId, state, alt: 'Oude tekst' });
  return { museum, me, other, reviewId, photo };
}

const alt = async (id: string) =>
  (await f.p.owner.query<{ alt_text: string | null }>('SELECT alt_text FROM media WHERE id = $1', [id])).rows[0]
    ?.alt_text;
const state = async (id: string) =>
  (await f.p.owner.query<{ state: string }>('SELECT state FROM media WHERE id = $1', [id])).rows[0]?.state;

describe('PATCH /media/:id', () => {
  it('anonymous 401, other host 401, owner 200, another member 404, banned 401, terms not accepted 403', async () => {
    const s = await scene();
    const path = `/media/${s.photo.id}`;
    const body = { alt_text: 'Nieuwe tekst' };

    const r401 = await f.t.call(path, { method: 'PATCH', body });
    expect(r401.status).toBe(401);
    expect(await r401.json()).toEqual({ error: 'unauthorized' });
    const adm = await f.t.signIn(s.me.id, 'admin');
    expect((await f.t.call(path, { method: 'PATCH', token: adm, body })).status).toBe(401);

    const r404 = await f.t.call(path, { method: 'PATCH', token: s.other.token, body });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not_found' });
    expect(await alt(s.photo.id)).toBe('Oude tekst');

    const r200 = await f.t.call(path, { method: 'PATCH', token: s.me.token, body });
    expect(r200.status).toBe(200);
    expect(r200.headers.get('cache-control')).toBe('private, no-store');
    expect(OwnPhoto.parse(await r200.json())).toMatchObject({
      id: s.photo.id,
      state: 'pending_review',
      alt_text: 'Nieuwe tekst',
      public_key: null,
    });
    expect(await alt(s.photo.id)).toBe('Nieuwe tekst');

    await f.p.owner.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [s.me.id, OLD_TERMS]);
    const r403 = await f.t.call(path, { method: 'PATCH', token: s.me.token, body: { alt_text: 'x' } });
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: 'terms_required' });
    expect(await alt(s.photo.id)).toBe('Nieuwe tekst');

    await f.p.owner.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [s.me.id]);
    expect((await f.t.call(path, { method: 'PATCH', token: s.me.token, body })).status).toBe(401);
  });

  it('takes one line of 1 to 250 code points, trims it, clears it with null and refuses the rest with 422', async () => {
    const s = await scene('approved');
    const path = `/media/${s.photo.id}`;
    const patch = (body: unknown) => f.t.call(path, { method: 'PATCH', token: s.me.token, body });
    const ok = async (v: string | null, want: string | null) => {
      const r = await patch({ alt_text: v });
      expect(r.status, String(v)).toBe(200);
      expect(await alt(s.photo.id)).toBe(want);
    };
    await ok('  een zaal  ', 'een zaal');
    await ok('a'.repeat(250), 'a'.repeat(250));
    await ok('\u{1F3A8}'.repeat(250), '\u{1F3A8}'.repeat(250));
    await ok(null, null);

    const bad = [
      '',
      '   ',
      'a'.repeat(251),
      '\u{1F3A8}'.repeat(251),
      'twee\nregels',
      `bel${String.fromCodePoint(7)}`,
      `bidi${String.fromCodePoint(0x202e)}tekst`,
      `is${String.fromCodePoint(0x2066)}o`,
      `se${String.fromCodePoint(0x2028)}p`,
      `nul${String.fromCodePoint(0)}`,
      `lone${String.fromCharCode(0xd800)}`,
      `del${String.fromCodePoint(0x7f)}`,
      5,
      ['a'],
      {},
    ];
    for (const v of bad) {
      const r = await patch({ alt_text: v });
      expect(r.status, JSON.stringify(v)).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields: ['alt_text'] });
    }
    expect(await alt(s.photo.id)).toBeNull();
    // Not the rule's business: the shape of the request.
    expect((await patch({})).status).toBe(422); // a missing alt_text names the field, like a missing body
    expect((await patch({ alt_text: 'x', extra: 1 })).status).toBe(400);
    expect((await f.t.call(path, { method: 'PATCH', token: s.me.token })).status).toBe(400);
    expect(
      (await f.t.call(`${path}?x=1`, { method: 'PATCH', token: s.me.token, body: { alt_text: 'x' } })).status,
    ).toBe(400);
  });

  it('is a 404 for a failed or removed photo, an unknown id and a malformed one', async () => {
    for (const st of ['failed', 'removed'] as const) {
      const s = await scene(st);
      const r = await f.t.call(`/media/${s.photo.id}`, { method: 'PATCH', token: s.me.token, body: { alt_text: 'x' } });
      expect(r.status, st).toBe(404);
    }
    const s = await scene();
    for (const id of ['0194f2c0-0000-7000-8000-00000000dead', 'not-a-uuid', s.photo.id.toUpperCase(), `${s.photo.id}x`])
      expect(
        (await f.t.call(`/media/${id}`, { method: 'PATCH', token: s.me.token, body: { alt_text: 'x' } })).status,
        id,
      ).toBe(404);
  });
});

describe('DELETE /media/:id', () => {
  it('anonymous 401, other host 401, another member 404, banned 401, owner 204 and the job, then 404', async () => {
    const s = await scene('approved');
    const path = `/media/${s.photo.id}`;
    expect((await f.t.call(path, { method: 'DELETE' })).status).toBe(401);
    const adm = await f.t.signIn(s.me.id, 'admin');
    expect((await f.t.call(path, { method: 'DELETE', token: adm })).status).toBe(401);

    const r404 = await f.t.call(path, { method: 'DELETE', token: s.other.token });
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: 'not_found' });
    expect(await state(s.photo.id)).toBe('approved');

    const banned = await scene();
    await f.p.owner.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [banned.me.id]);
    expect((await f.t.call(`/media/${banned.photo.id}`, { method: 'DELETE', token: banned.me.token })).status).toBe(
      401,
    );
    expect(await state(banned.photo.id)).toBe('pending_review');

    const r204 = await f.t.call(path, { method: 'DELETE', token: s.me.token });
    expect(r204.status).toBe(204);
    expect(r204.headers.get('cache-control')).toBe('private, no-store');
    expect(await state(s.photo.id)).toBe('removed');
    const jobs = await f.p.owner.query("SELECT 1 FROM job WHERE kind = 'media_delete' AND payload->>'media_id' = $1", [
      s.photo.id,
    ]);
    expect(jobs.rowCount).toBe(1);
    // Gone from the public list at once, though the file waits for the worker.
    expect(await (await f.t.call(`/museums/${s.museum.slug}/photos`)).text()).not.toContain(s.photo.id);
    expect((await f.t.call(path, { method: 'DELETE', token: s.me.token })).status).toBe(404);
  });

  it('is allowed without the current terms, and a failed photo, an unknown id and a malformed one are 404', async () => {
    const s = await scene();
    await f.p.owner.query('UPDATE app_user SET terms_version = $2 WHERE id = $1', [s.me.id, OLD_TERMS]);
    expect((await f.t.call(`/media/${s.photo.id}`, { method: 'DELETE', token: s.me.token })).status).toBe(204);
    const failed = await scene('failed');
    for (const id of [failed.photo.id, '0194f2c0-0000-7000-8000-00000000dead', 'x', '1'])
      expect((await f.t.call(`/media/${id}`, { method: 'DELETE', token: failed.me.token })).status, id).toBe(404);
  });
});

describe('the public photo lists', () => {
  it('answer the same without a cookie and with one (good, stale, banned), as api and as ssr, and are GET-only', async () => {
    const s = await scene('approved');
    const banned = await f.member(s.museum.id);
    await f.p.owner.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [banned.id]);
    for (const path of [`/museums/${s.museum.slug}/photos`, `/users/${s.me.handle}/photos`]) {
      const anon = await f.t.call(path);
      expect(anon.status, path).toBe(200);
      expect(anon.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
      const bytes = await anon.text();
      expect(bytes).toContain(s.photo.id);
      for (const token of [s.me.token, s.other.token, banned.token, 'x'.repeat(43)]) {
        const r = await f.t.call(path, { token });
        expect(r.status, path).toBe(200);
        expect(await r.text(), path).toBe(bytes);
      }
      expect(await (await f.ssrGet(path)).text(), path).toBe(bytes);
      expect((await f.t.call(path, { method: 'POST', token: s.me.token, body: {} })).status, `${path} POST`).toBe(404);
      expect((await f.t.call(`${path}?limit=0`)).status).toBe(400);
      expect((await f.t.call(`${path}?x=1`)).status).toBe(400);
    }
  });

  it('stop listing a banned author’s handle but keep the photo on the museum list without it', async () => {
    const s = await scene('approved');
    await f.p.owner.query("UPDATE app_user SET status = 'banned' WHERE id = $1", [s.me.id]);
    expect((await f.t.call(`/users/${s.me.handle}/photos`)).status).toBe(404);
    const list = PhotoList.parse(await (await f.t.call(`/museums/${s.museum.slug}/photos`)).json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.author_handle).toBeNull();
  });
});
