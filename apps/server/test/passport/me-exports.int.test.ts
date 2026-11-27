import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMeExports } from '../../src/api/routes/me-exports.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// The export routes' rules (A§10, P2c Q5): sign-in, one open export per member, a stuck one stops blocking
// after an hour, three a day, files only while ready and unexpired, private answers, quiet logs. The job
// and the download are export.int.test.ts's.

let p: PassportDb;
let app: ReturnType<typeof meApp>;
const dir = mkdtempSync(join(tmpdir(), 'mjk-exports-'));
beforeAll(async () => {
  p = await openPassportDb();
  app = meApp(p, (v1, d) => mountMeExports(v1, { ...d, exportsDir: dir }));
}, 120_000);
afterAll(() => p.close());

type Item = { id: string; state: string; expires_at: string | null; files: string[] };
const request = (token?: string) => app.call('/me/exports', { method: 'POST', ...(token ? { token } : {}) });
const list = async (token: string) => {
  const r = await app.call('/me/exports', { token });
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return ((await r.json()) as { items: Item[] }).items;
};
const member = async () => {
  const u = await p.newMember();
  return { ...u, token: await app.signIn(u.id) };
};
const setRow = (id: string, set: string) => p.owner.query(`UPDATE data_export SET ${set} WHERE id = $1`, [id]);

describe('the export routes', () => {
  it('401 without a session, private and uncacheable', async () => {
    for (const r of [
      await request(),
      await app.call('/me/exports'),
      await app.call('/me/exports/00000000-0000-4000-8000-000000000001/export.json'),
    ]) {
      expect(r.status).toBe(401);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('202 with the queued item and its job, then 409 while it is queued', async () => {
    const u = await member();
    const r = await request(u.token);
    expect(r.status).toBe(202);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const item = (await r.json()) as Item;
    expect(item).toMatchObject({ state: 'queued', expires_at: null, files: [] });
    const jobs = await p.owner.query(
      `SELECT payload FROM job WHERE kind = 'data_export' AND payload->>'export_id' = $1`,
      [item.id],
    );
    expect(jobs.rows.map((j) => j.payload)).toEqual([{ export_id: item.id }]);

    const again = await request(u.token);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'conflict' });
    // Another member is not blocked by it.
    expect((await request((await member()).token)).status).toBe(202);
  });

  it('a queued row older than an hour no longer blocks and becomes failed', async () => {
    const u = await member();
    const first = (await (await request(u.token)).json()) as Item;
    await setRow(first.id, `created_at = now() - interval '61 minutes'`);
    const r = await request(u.token);
    expect(r.status).toBe(202);
    const states = Object.fromEntries((await list(u.token)).map((i) => [i.id, i.state]));
    expect(states[first.id]).toBe('failed');
    expect(states[((await r.json()) as Item).id]).toBe('queued');
  });

  it('the fourth request in a day is a 429 with Retry-After', async () => {
    const u = await member();
    for (let i = 0; i < 3; i++) {
      const r = await request(u.token);
      expect(r.status).toBe(202);
      await setRow(((await r.json()) as Item).id, `state = 'failed'`);
    }
    const r = await request(u.token);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await list(u.token)).length).toBe(3);
  });

  it('lists the files only while ready and unexpired, newest first, and only the member’s own', async () => {
    const u = await member();
    const item = (await (await request(u.token)).json()) as Item;
    expect((await list(u.token)).map((i) => i.files)).toEqual([[]]);
    await setRow(item.id, `state = 'ready', expires_at = now() + interval '1 hour'`);
    expect(await list(u.token)).toMatchObject([
      { id: item.id, state: 'ready', files: ['export.json', 'visits.csv', 'wishlist.csv'] },
    ]);
    await setRow(item.id, `expires_at = now() - interval '1 second'`);
    expect(await list(u.token)).toMatchObject([{ id: item.id, state: 'ready', files: [] }]);
    // A second one, newer: listed first.
    const next = (await (await request(u.token)).json()) as Item;
    expect((await list(u.token)).map((i) => i.id)).toEqual([next.id, item.id]);
    expect(await list((await member()).token)).toEqual([]);
  });

  it('a download path that is not ours: 400 for a bad id, 404 for an unknown file name or export', async () => {
    const u = await member();
    expect((await app.call('/me/exports/nope/export.json', { token: u.token })).status).toBe(400);
    const item = (await (await request(u.token)).json()) as Item;
    await setRow(item.id, `state = 'ready', expires_at = now() + interval '1 hour'`);
    for (const file of ['passwd', '..%2Fx', 'export.JSON', 'visits.csv.bak']) {
      const r = await app.call(`/me/exports/${item.id}/${file}`, { token: u.token });
      expect(r.status, file).toBe(404);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
    // Ready in the database but no bundle on disk (purged): 404, never a 500.
    expect((await app.call(`/me/exports/${item.id}/export.json`, { token: u.token })).status).toBe(404);
  });

  it('the request log holds the route pattern, never an export id or a file name', async () => {
    const u = await member();
    const item = (await (await request(u.token)).json()) as Item;
    await app.call(`/me/exports/${item.id}/visits.csv`, { token: u.token });
    const text = JSON.stringify(app.lines());
    expect(text).not.toContain(item.id);
    expect(text).not.toContain('visits.csv');
    expect(text).toContain('/me/exports/:id/:file');
  });
});
