import { BulkResult, ErrorBody, Visit, VisitList } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayAmsterdam } from '../../src/admin/dates.ts';
import { mountMeVisits } from '../../src/api/routes/me-visits.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// /me/visits and /me/visits/bulk (A§10, A§14): the log, its keyset paging, the date rules, the unique visit
// per museum and date, the onboarding bulk tick, and that a member sees only their own rows.

let p: PassportDb;
beforeAll(async () => {
  p = await openPassportDb();
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const setup = () => {
  const t = meApp(p, mountMeVisits);
  return { ...t, as: async (userId: string) => ({ token: await t.signIn(userId) }) };
};
const tomorrow = () => {
  const [y, m, d] = todayAmsterdam().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const err = async (r: Response) => ErrorBody.parse(await r.json());

describe('signed out', () => {
  it('every route is 401, private and uncacheable', async () => {
    const { call } = setup();
    const id = '0198a5a0-0000-7000-8000-000000000000';
    for (const [method, path, body] of [
      ['GET', '/me/visits'],
      ['POST', '/me/visits', { museum_id: id, visited_on: null }],
      ['POST', '/me/visits/bulk', { museum_ids: [id] }],
      ['PATCH', `/me/visits/${id}`, { note: 'x' }],
      ['DELETE', `/me/visits/${id}`],
    ] as const) {
      const r = await call(path, { method, ...(body === undefined ? {} : { body }) });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('POST /me/visits', () => {
  it('creates a manual visit, 201, private; the note comes back to its owner only', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const other = await p.newMember();
    const m = await p.visible(0);
    const r = await call('/me/visits', {
      ...(await as(u.id)),
      body: { museum_id: m.id, visited_on: '2026-05-01', note: 'Mooi' },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const v = Visit.parse(await r.json());
    expect(v).toMatchObject({
      visited_on: '2026-05-01',
      note: 'Mooi',
      source: 'manual',
      museum: { id: m.id, slug: m.slug },
    });
    // Another member neither lists it nor reads or changes it.
    const list = VisitList.parse(await (await call('/me/visits', await as(other.id))).json());
    expect(list.items).toEqual([]);
    expect(
      (await call(`/me/visits/${v.id}`, { method: 'PATCH', ...(await as(other.id)), body: { note: 'x' } })).status,
    ).toBe(404);
  });

  it('an undated visit is allowed once per museum; the same museum and date, undated included, is 409', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const m = await p.visible(1);
    const dated = { museum_id: m.id, visited_on: '2026-04-02' };
    expect((await call('/me/visits', { ...t, body: dated })).status).toBe(201);
    const again = await call('/me/visits', { ...t, body: dated });
    expect(again.status).toBe(409);
    expect(await err(again)).toEqual({ error: 'conflict' });
    const undated = { museum_id: m.id, visited_on: null };
    expect((await call('/me/visits', { ...t, body: undated })).status).toBe(201);
    expect((await call('/me/visits', { ...t, body: undated })).status).toBe(409);
  });

  it('a future date (tomorrow, Amsterdam) or one before 1900 is 422 naming visited_on; today is fine', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const m = await p.visible(2);
    for (const visited_on of [tomorrow(), '1899-12-31']) {
      const r = await call('/me/visits', { ...t, body: { museum_id: m.id, visited_on } });
      expect(r.status).toBe(422);
      expect(await err(r)).toEqual({ error: 'invalid', fields: ['visited_on'] });
    }
    expect((await call('/me/visits', { ...t, body: { museum_id: m.id, visited_on: todayAmsterdam() } })).status).toBe(
      201,
    );
    expect((await call('/me/visits', { ...t, body: { museum_id: m.id, visited_on: '1900-01-01' } })).status).toBe(201);
  });

  it('an unknown or hidden museum is 422 naming museum_id; nothing is stored', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const hidden = await p.hidden();
    for (const museum_id of [hidden.id, '0198a5a0-0000-7000-8000-000000000001']) {
      const r = await call('/me/visits', { ...t, body: { museum_id, visited_on: null } });
      expect(r.status).toBe(422);
      expect(await err(r)).toEqual({ error: 'invalid', fields: ['museum_id'] });
    }
    expect((await p.owner.query('SELECT 1 FROM visit WHERE user_id = $1', [u.id])).rowCount).toBe(0);
  });

  it('a strict body: an unknown key, a bad uuid or a NUL in the note is 400', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const m = await p.visible(3);
    for (const body of [
      { museum_id: m.id, visited_on: null, source: 'import' },
      { museum_id: 'not-a-uuid', visited_on: null },
      { museum_id: m.id, visited_on: null, note: 'a\u{0}b' },
      { museum_id: m.id },
    ]) {
      expect((await call('/me/visits', { ...t, body })).status).toBe(400);
    }
  });
});

describe('GET /me/visits', () => {
  it('lists newest first, undated last, in stable pages with no repeat or gap', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const dates = ['2026-01-05', '2026-03-01', '2025-12-31', null, '2026-03-01', null, '2024-02-29'];
    const want: { id: string; on: string | null }[] = [];
    for (const [i, on] of dates.entries()) {
      // One museum per row, so no two rows collide on museum and date.
      const id = await p.addVisit(u.id, (await p.visible(10 + i)).id, { on });
      want.push({ id, on });
    }
    const expected = [...want].sort((a, b) =>
      a.on === b.on ? (a.id < b.id ? 1 : -1) : a.on === null ? 1 : b.on === null ? -1 : a.on < b.on ? 1 : -1,
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await call(`/me/visits?limit=3${cursor === undefined ? '' : `&cursor=${cursor}`}`, t);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      const body = VisitList.parse(await r.json());
      seen.push(...body.items.map((v) => v.id));
      if (body.next === null) break;
      cursor = body.next;
    }
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it('a malformed or foreign cursor is 400 naming cursor; an unknown parameter is 400', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const cursorOf = (d: string) =>
      `cursor=${Buffer.from(JSON.stringify({ d, i: '00000000-0000-4000-8000-000000000000' })).toString('base64url')}`;
    for (const q of [
      'cursor=@@@',
      'cursor=e30',
      `cursor=${Buffer.from('{"d":"x","i":"y"}').toString('base64url')}`,
      cursorOf('0000-01-01'),
      cursorOf('1899-12-31'),
      cursorOf('2025-02-29'),
    ]) {
      const r = await call(`/me/visits?${q}`, t);
      expect(r.status, q).toBe(400);
      expect(await err(r)).toEqual({ error: 'bad_request', fields: ['cursor'] });
    }
    expect((await call('/me/visits?foo=1', t)).status).toBe(400);
  });

  it('a museum hidden after the visit still shows by name, with slug null', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const m = await p.visible(60);
    await p.addVisit(u.id, m.id);
    await p.owner.query('UPDATE museum SET hidden = true WHERE id = $1', [m.id]);
    try {
      const list = VisitList.parse(await (await call('/me/visits', await as(u.id))).json());
      expect(list.items[0]?.museum).toMatchObject({ id: m.id, slug: null });
      expect(list.items[0]?.museum.name.length).toBeGreaterThan(0);
    } finally {
      await p.owner.query('UPDATE museum SET hidden = false WHERE id = $1', [m.id]);
    }
  });
});

describe('PATCH /me/visits/:id', () => {
  it('changes the date and the note; null clears; an omitted field stays', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const id = await p.addVisit(u.id, (await p.visible(20)).id, { on: '2026-02-02', note: 'eerst' });
    let r = await call(`/me/visits/${id}`, { method: 'PATCH', ...t, body: { note: 'tweede' } });
    expect(Visit.parse(await r.json())).toMatchObject({ visited_on: '2026-02-02', note: 'tweede' });
    r = await call(`/me/visits/${id}`, { method: 'PATCH', ...t, body: { visited_on: null, note: null } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(Visit.parse(await r.json())).toMatchObject({ visited_on: null, note: null });
  });

  it('a future date is 422; moving onto an existing date of the museum is 409', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const m = await p.visible(21);
    const a = await p.addVisit(u.id, m.id, { on: '2026-02-02' });
    await p.addVisit(u.id, m.id, { on: '2026-03-03' });
    const future = await call(`/me/visits/${a}`, { method: 'PATCH', ...t, body: { visited_on: tomorrow() } });
    expect(future.status).toBe(422);
    expect(await err(future)).toEqual({ error: 'invalid', fields: ['visited_on'] });
    const clash = await call(`/me/visits/${a}`, { method: 'PATCH', ...t, body: { visited_on: '2026-03-03' } });
    expect(clash.status).toBe(409);
    expect(await err(clash)).toEqual({ error: 'conflict' });
    // Moving to undated is fine once, and 409 when an undated one exists.
    await p.addVisit(u.id, m.id, { on: null });
    expect((await call(`/me/visits/${a}`, { method: 'PATCH', ...t, body: { visited_on: null } })).status).toBe(409);
  });

  it("another member's or an unknown id is 404; a bad id is 400; an empty patch is 400", async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const other = await as((await p.newMember()).id);
    const id = await p.addVisit(u.id, (await p.visible(22)).id, { note: 'privé' });
    expect((await call(`/me/visits/${id}`, { method: 'PATCH', ...other, body: { note: 'x' } })).status).toBe(404);
    expect(
      (
        await call('/me/visits/0198a5a0-0000-7000-8000-000000000009', {
          method: 'PATCH',
          ...other,
          body: { note: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await call('/me/visits/nope', { method: 'PATCH', ...other, body: { note: 'x' } })).status).toBe(400);
    const mine = await as(u.id);
    expect((await call(`/me/visits/${id}`, { method: 'PATCH', ...mine, body: {} })).status).toBe(400);
    expect((await p.owner.query('SELECT note FROM visit WHERE id = $1', [id])).rows[0]).toEqual({ note: 'privé' });
  });
});

describe('DELETE /me/visits/:id', () => {
  it("deletes the member's visit (204); another member's or an unknown one is 404", async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const other = await as((await p.newMember()).id);
    const id = await p.addVisit(u.id, (await p.visible(23)).id);
    expect((await call(`/me/visits/${id}`, { method: 'DELETE', ...other })).status).toBe(404);
    const r = await call(`/me/visits/${id}`, { method: 'DELETE', ...t });
    expect(r.status).toBe(204);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await call(`/me/visits/${id}`, { method: 'DELETE', ...t })).status).toBe(404);
  });
});

describe('POST /me/visits/bulk', () => {
  it('adds one undated bulk visit per new visible museum; dedupes; skips visited, hidden and unknown', async () => {
    const { call, as } = setup();
    const u = await p.newMember();
    const t = await as(u.id);
    const [a, b, c, d] = [await p.visible(30), await p.visible(31), await p.visible(32), await p.visible(33)];
    const hidden = await p.hidden();
    await p.addVisit(u.id, c.id, { on: '2026-01-01' }); // dated visit: counts as visited
    await p.addVisit(u.id, d.id, { on: null });
    const ids = [a.id, a.id, a.id.toUpperCase(), b.id, c.id, d.id, hidden.id, '0198a5a0-0000-7000-8000-000000000002'];
    const r = await call('/me/visits/bulk', { ...t, body: { museum_ids: ids } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    // Distinct ids: a, b, c, d, hidden, unknown = 6; two are added.
    expect(BulkResult.parse(await r.json())).toEqual({ added: 2, skipped: 4 });
    const rows = (
      await p.owner.query('SELECT museum_id, visited_on::text AS on, source FROM visit WHERE user_id = $1', [u.id])
    ).rows as { museum_id: string; on: string | null; source: string }[];
    expect(
      rows
        .filter((x) => x.source === 'bulk')
        .map((x) => x.museum_id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(rows.filter((x) => x.source === 'bulk').every((x) => x.on === null)).toBe(true);
    expect(rows).toHaveLength(4);
    // A second identical bulk adds nothing.
    const again = await call('/me/visits/bulk', { ...t, body: { museum_ids: ids } });
    expect(BulkResult.parse(await again.json())).toEqual({ added: 0, skipped: 6 });
  });

  it('is strict: no ids, over 200 ids, a bad uuid or an unknown key is 400', async () => {
    const { call, as } = setup();
    const t = await as((await p.newMember()).id);
    const id = '0198a5a0-0000-7000-8000-000000000003';
    const many = Array.from({ length: 201 }, (_, i) => `0198a5a0-0000-7000-8000-${String(i).padStart(12, '0')}`);
    for (const body of [
      { museum_ids: [] },
      { museum_ids: many },
      { museum_ids: ['x'] },
      { museum_ids: [id], extra: 1 },
    ]) {
      expect((await call('/me/visits/bulk', { ...t, body })).status).toBe(400);
    }
  });
});
