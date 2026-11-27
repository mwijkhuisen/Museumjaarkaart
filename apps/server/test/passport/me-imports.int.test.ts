import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPORT_BODY_LIMIT_BYTES } from '../../src/api/app.ts';
import { mountMeImports } from '../../src/api/routes/me-imports.ts';
import { userKey } from '../../src/auth/limiter.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c criterion 4 and the import routes' rules: sign-in, limits, strict bodies, one pending import per
// member, a second confirm, another member's import, the hourly bucket, private answers, quiet logs.

let p: PassportDb;
let app: ReturnType<typeof meApp>;
beforeAll(async () => {
  p = await openPassportDb();
  app = meApp(p, mountMeImports);
}, 120_000);
afterAll(() => p.close());

const upload = (token: string | undefined, format: string, content: string) =>
  app.call('/me/imports', { ...(token === undefined ? {} : { token }), body: { format, content } });
const member = async () => app.signIn((await p.newMember()).id);
const json = async (r: Response) => (await r.json()) as { id: string; error?: string; fields?: string[] };
const pending = async (userId: string) =>
  (await p.owner.query('SELECT id FROM visit_import WHERE user_id = $1 AND state = $2', [userId, 'pending'])).rows;

describe('POST /me/imports', () => {
  it('401 without a session, private and uncacheable', async () => {
    const r = await upload(undefined, 'csv', 'museum\nA\n');
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await app.call('/me/imports/00000000-0000-4000-8000-000000000001/confirm', { body: {} })).status).toBe(401);
  });

  it('413 for 5,001 rows and for a body over 2 MiB', async () => {
    const token = await member();
    const rows = await upload(token, 'csv', `museum\n${'A\n'.repeat(5001)}`);
    expect(rows.status).toBe(413);
    expect(await rows.json()).toEqual({ error: 'too_large', fields: ['content'] });
    expect(rows.headers.get('cache-control')).toBe('private, no-store');
    // 5,000 rows are fine.
    expect((await upload(token, 'csv', `museum\n${'A\n'.repeat(5000)}`)).status).toBe(201);

    const big = await app.call('/me/imports', { token, raw: ' '.repeat(IMPORT_BODY_LIMIT_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    // The confirm has the same cap; any other route stops at 64 KiB.
    const confirm = await app.call('/me/imports/00000000-0000-4000-8000-000000000001/confirm', {
      token,
      raw: ' '.repeat(IMPORT_BODY_LIMIT_BYTES + 1),
    });
    expect(confirm.status).toBe(413);
    expect((await app.call('/me/email', { token, raw: ' '.repeat(65 * 1024) })).status).toBe(413);
  });

  it('422 for a bad header, a bad quote, an empty file and a format whose parser is not built', async () => {
    const token = await member();
    for (const [format, content, field] of [
      ['csv', 'kolom,andere\nA,B\n', 'content'],
      ['csv', 'museum\n"open\n', 'content'],
      ['csv', '', 'content'],
      ['mjk', '{', 'content'],
      ['museotrack', 'museum\nA\n', 'format'],
      ['cultra', 'museum\nA\n', 'format'],
    ] as const) {
      const r = await upload(token, format, content);
      expect(r.status, `${format} ${content}`).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields: [field] });
    }
    expect((await upload(token, 'nope', 'x')).status).toBe(400);
  });

  it('a new import replaces the pending one', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const first = await json(await upload(token, 'csv', 'museum\nA\n'));
    const second = await json(await upload(token, 'csv', 'museum\nB\n'));
    expect(second.id).not.toBe(first.id);
    expect((await pending(u.id)).map((r) => r.id)).toEqual([second.id]);
    // The replaced one is gone: its confirm is a 404.
    const r = await app.call(`/me/imports/${first.id}/confirm`, { token, body: { choose: [], skip: [] } });
    expect(r.status).toBe(404);
  });

  it('429 on the eleventh upload in an hour, with Retry-After, for that member only', async () => {
    const { id } = await p.newMember();
    const token = await app.signIn(id);
    for (let i = 0; i < 10; i++) expect((await upload(token, 'csv', 'museum\nA\n')).status).toBe(201);
    const r = await upload(token, 'csv', 'museum\nA\n');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await upload(await member(), 'csv', 'museum\nA\n')).status).toBe(201);
    // The bucket's key is an HMAC of the member's id, never the id itself (invariant 8).
    const keys = await p.owner.query<{ key: string }>(
      `SELECT key FROM rate_limit WHERE bucket = 'import_user_hour' AND count = 11`,
    );
    expect(keys.rows.map((k) => k.key)).toEqual([userKey(app.keys, 'import', id)]);
    expect(keys.rows[0]?.key).not.toContain(id);
  });

  it('writes no row content to the request log', async () => {
    const token = await member();
    const secret = 'Geheime Notitie Zzyzx';
    await upload(token, 'csv', `museum,notitie\nBestaat Niet Qwxz,${secret}\n`);
    await upload(token, 'csv', `museum,notitie\n"open,${secret}\n`);
    const text = JSON.stringify(app.lines());
    expect(text).not.toContain('Zzyzx');
    expect(text).not.toContain('Qwxz');
  });
});

describe('POST /me/imports/:id/confirm', () => {
  it('409 for a second confirm, 404 for another member and for an unknown id, 400 for a bad id', async () => {
    const mine = await member();
    const theirs = await member();
    const { id } = await json(await upload(mine, 'csv', 'museum\nA\n'));
    const url = (i: string) => `/me/imports/${i}/confirm`;
    const body = { choose: [], skip: [] };

    expect((await app.call(url(id), { token: theirs, body })).status).toBe(404);
    const ok = await app.call(url(id), { token: mine, body });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(await ok.json()).toEqual({ visits: 0, wishlist: 0, reviews: 0, skipped: 0 });
    const again = await app.call(url(id), { token: mine, body });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'conflict' });
    // Another member's confirmed import is still a 404 to them, never a 409.
    expect((await app.call(url(id), { token: theirs, body })).status).toBe(404);
    expect((await app.call(url('00000000-0000-4000-8000-000000000001'), { token: mine, body })).status).toBe(404);
    expect((await app.call(url('nope'), { token: mine, body })).status).toBe(400);
    // The body is strict.
    const fresh = await json(await upload(mine, 'csv', 'museum\nA\n'));
    expect((await app.call(url(fresh.id), { token: mine, body: { choose: [], skip: [], extra: 1 } })).status).toBe(400);
    expect((await app.call(url(fresh.id), { token: mine, body: {} })).status).toBe(400);
  });

  it('422 for a row that is not in the import, an invalid row, a row in both lists or a chosen row twice', async () => {
    const token = await member();
    const museum = await p.visible(7);
    const { id } = await json(
      await upload(token, 'csv', 'museum,datum\nBestaat Niet Qwxz,2026-01-01\nKapot,gisteren\n'),
    );
    const confirm = (body: object) => app.call(`/me/imports/${id}/confirm`, { token, body });
    const expectInvalid = async (body: object, fields: string[]) => {
      const r = await confirm(body);
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'invalid', fields });
    };
    await expectInvalid({ choose: [{ row: 9, museum_id: museum.id }], skip: [] }, ['choose']);
    await expectInvalid({ choose: [{ row: 2, museum_id: museum.id }], skip: [] }, ['choose']); // invalid row
    await expectInvalid({ choose: [], skip: [9] }, ['skip']);
    await expectInvalid({ choose: [{ row: 1, museum_id: museum.id }], skip: [1] }, ['choose', 'skip']);
    await expectInvalid(
      {
        choose: [
          { row: 1, museum_id: museum.id },
          { row: 1, museum_id: museum.id },
        ],
        skip: [],
      },
      ['choose'],
    );
    await expectInvalid({ choose: [{ row: 1, museum_id: '00000000-0000-4000-8000-000000000001' }], skip: [] }, [
      'choose',
    ]);
    // None of that consumed the import.
    expect((await confirm({ choose: [{ row: 1, museum_id: museum.id }], skip: [] })).status).toBe(200);
  });

  it('answers the counts as a strict contract and logs no row content', async () => {
    const token = await member();
    const { id } = await json(await upload(token, 'csv', 'museum\nBestaat Niet Qwxz\n'));
    await app.call(`/me/imports/${id}/confirm`, { token, body: { choose: [], skip: [] } });
    expect(JSON.stringify(app.lines())).not.toContain('Qwxz');
  });
});
