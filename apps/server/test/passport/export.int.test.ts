import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayAmsterdam } from '../../src/admin/dates.ts';
import { mountMeExports } from '../../src/api/routes/me-exports.ts';
import { mountMeImports } from '../../src/api/routes/me-imports.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { memoryMailer } from '../../src/mail/mailer.ts';
import { MAIL_EXPORT_JOB } from '../../src/mail/payloads.ts';
import { DATA_EXPORT_JOB, dataExportJob } from '../../src/passport/export/job.ts';
import { parseCsv } from '../../src/passport/import/csv.ts';
import { parseMjk } from '../../src/passport/import/mjk.ts';
import { MjkExportV1 } from '../../src/passport/mjk-format.ts';
import { mailJobs } from '../../src/worker/mail.ts';
import type { JobHandler } from '../../src/worker/types.ts';
import { meApp } from '../api/me-app.ts';
import { openPassportDb, type PassportDb } from './fixtures.ts';

// P2c criterion 8: export → import (`mjk`) into a fresh account gives the same visits and wishlist; the
// download works only for its member and until it expires. Plus: no secret in the bundle, the CSV formula
// guard, the file modes, and the mail (the account link only, in the member's locale; none when expired).

const BRAND = ['Test', 'Brand'].join('');
const ENV = { MJK_BRAND_NAME: BRAND, MJK_DOMAIN: 'example.test', MJK_MAIL_CAP: '300' };
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2VjcmV0c2FsdA$c2VjcmV0aGFzaHNlY3JldGhhc2g';

let p: PassportDb;
let app: ReturnType<typeof meApp>;
const dir = mkdtempSync(join(tmpdir(), 'mjk-exports-'));
beforeAll(async () => {
  p = await openPassportDb();
  app = meApp(p, (v1, d) => {
    mountMeImports(v1, d);
    mountMeExports(v1, { ...d, exportsDir: dir });
  });
}, 120_000);
afterAll(() => p.close());

/** Runs the queued jobs of a kind once, through the real handlers, as mjk_worker; returns what the mailer sent. */
async function runJobs(kind: string) {
  const mail = memoryMailer();
  const handlers: Record<string, JobHandler> = {
    [DATA_EXPORT_JOB]: dataExportJob({ db: p.worker, exportsDir: dir }),
    ...mailJobs({ db: p.worker, keys: app.keys, mailer: mail.mailer, logger: memoryLogger('worker').logger, env: ENV }),
  };
  const jobs = await p.admin.query(`SELECT id, payload FROM job WHERE kind = $1 AND state = 'queued' ORDER BY id`, [
    kind,
  ]);
  for (const j of jobs.rows) {
    const handler = handlers[kind];
    if (handler === undefined) throw new Error('no handler');
    await handler(j.payload, { signal: new AbortController().signal });
    await p.admin.query('DELETE FROM job WHERE id = $1', [j.id]);
  }
  return mail.sent();
}

const download = (id: string, file: string, token?: string) =>
  app.call(`/me/exports/${id}/${file}`, token === undefined ? {} : { token });

async function exportOf(token: string): Promise<string> {
  const r = await app.call('/me/exports', { method: 'POST', token });
  expect(r.status).toBe(202);
  const { id } = (await r.json()) as { id: string };
  await runJobs(DATA_EXPORT_JOB);
  return id;
}

describe('the data export', () => {
  let alice: { id: string; email: string; token: string };
  let exportId: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    const u = await p.newUser({ password_hash: HASH });
    alice = { ...u, token: await app.signIn(u.id) };
    const [a, b, c, d] = [await p.listed(0), await p.visible(0), await p.visible(1), await p.listed(1)];
    await p.addVisit(u.id, a.id, { on: '2026-03-14', note: 'Mooi, met "quotes", komma’s\nen een regel' });
    await p.addVisit(u.id, a.id, { on: '2025-12-01' });
    await p.addVisit(u.id, b.id, { on: null });
    await p.addVisit(u.id, c.id, { on: '2024-07-02', note: '=HYPERLINK("https://evil.test")' });
    await p.addWishlist(u.id, d.id);
    await p.addWishlist(u.id, b.id);
    // A passkey (P2b): its name goes in the bundle, its credential id and public key never do.
    await p.admin.query(
      `INSERT INTO passkey (credential_id, user_id, public_key, backed_up, name, transports)
       VALUES (decode(repeat('c1', 16), 'hex'), $1, decode(repeat('b7', 64), 'hex'), true, 'Laptop', '{internal}')`,
      [u.id],
    );
    // A sign-in code row for her address: its HMAC must not reach the bundle.
    await p.admin.query(
      `INSERT INTO email_code (email, purpose, code_hmac, expires_at)
       VALUES ($1, 'signin', decode(repeat('5e', 32), 'hex'), now() + interval '10 minutes')`,
      [u.email],
    );
    exportId = await exportOf(alice.token);
    for (const f of ['export.json', 'visits.csv', 'wishlist.csv']) {
      const r = await download(exportId, f, alice.token);
      expect(r.status, f).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(r.headers.get('content-disposition')).toBe(`attachment; filename="${f}"`);
      expect(r.headers.get('content-type')).toBe(
        f.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      );
      files[f] = await r.text();
    }
  });

  it('turns the row ready for 24 hours and lists its files', async () => {
    const row = await p.owner.query(
      `SELECT state, expires_at - now() BETWEEN interval '23 hours 59 minutes' AND interval '24 hours' AS day
         FROM data_export WHERE id = $1`,
      [exportId],
    );
    expect(row.rows).toEqual([{ state: 'ready', day: true }]);
    const list = (await (await app.call('/me/exports', { token: alice.token })).json()) as { items: { files: [] }[] };
    expect(list.items[0]?.files).toEqual(['export.json', 'visits.csv', 'wishlist.csv']);
  });

  it('holds her account, visits with notes, wishlist, sessions and exports', () => {
    const json = JSON.parse(files['export.json'] as string);
    expect(json).toMatchObject({ format: 'mjk', version: 1, account: { email: alice.email } });
    expect(json.visits).toHaveLength(4);
    expect(json.wishlist).toHaveLength(2);
    expect(json.sessions).toMatchObject([{ host: 'public', method: 'code' }]);
    expect(json.passkeys).toEqual([
      { name: 'Laptop', transports: ['internal'], backed_up: true, created_at: expect.any(String), last_used_at: null },
    ]);
    expect(json.exports).toMatchObject([{ state: 'queued' }]);
    expect(json.account.settings.locale).toBe('nl');
  });

  it('import (mjk) into a fresh account gives the same visits and wishlist', async () => {
    const fresh = await p.newMember();
    const token = await app.signIn(fresh.id);
    const up = await app.call('/me/imports', { token, body: { format: 'mjk', content: files['export.json'] } });
    expect(up.status).toBe(201);
    const preview = (await up.json()) as { id: string; counts: Record<string, number> };
    expect(preview.counts).toEqual({ matched: 6, ambiguous: 0, unmatched: 0, invalid: 0 });
    const done = await app.call(`/me/imports/${preview.id}/confirm`, { token, body: { choose: [], skip: [] } });
    expect(await done.json()).toEqual({ visits: 4, wishlist: 2, reviews: 0, skipped: 0 });

    const visits = (id: string) =>
      p.owner
        .query(
          `SELECT museum_id, visited_on::text AS visited_on, note FROM visit WHERE user_id = $1
            ORDER BY museum_id, visited_on NULLS FIRST`,
          [id],
        )
        .then((r) => r.rows);
    const wishlist = (id: string) =>
      p.owner.query('SELECT museum_id FROM wishlist WHERE user_id = $1 ORDER BY 1', [id]).then((r) => r.rows);
    expect(await visits(fresh.id)).toEqual(await visits(alice.id));
    expect(await wishlist(fresh.id)).toEqual(await wishlist(alice.id));
  });

  it('its visits.csv imports as visits and its wishlist.csv as wishlist entries', () => {
    const kinds = (name: 'visits.csv' | 'wishlist.csv') => {
      const r = parseCsv(files[name] as string, todayAmsterdam());
      return r.ok ? r.rows.map((row) => row.kind) : r.error;
    };
    expect(kinds('visits.csv')).toEqual(['visit', 'visit', 'visit', 'visit']);
    expect(kinds('wishlist.csv')).toEqual(['wishlist', 'wishlist']);
  });

  it('downloads only for its member: another member 404, signed out 401', async () => {
    const bob = await app.signIn((await p.newMember()).id);
    expect((await download(exportId, 'export.json', bob)).status).toBe(404);
    expect((await download(exportId, 'export.json')).status).toBe(401);
  });

  it('holds no secret: no password hash, code HMAC, session id, app key or passkey key material', async () => {
    const all = Object.values(files).join('\n');
    const sessions = await p.admin.query(`SELECT encode(id, 'hex') AS hex FROM session WHERE user_id = $1`, [alice.id]);
    expect(sessions.rows.length).toBeGreaterThan(0);
    const needles = [
      HASH,
      'c2VjcmV0aGFzaHNlY3JldGhhc2g',
      '5e'.repeat(32),
      alice.token,
      ...sessions.rows.map((r) => r.hex as string),
      ...Object.values(app.keys).flatMap((k) => [k.toString('hex'), k.toString('base64url'), k.toString('base64')]),
      // the passkey's credential id and public key, in every encoding a careless export could use
      ...['c1'.repeat(16), 'b7'.repeat(64)].flatMap((hex) => {
        const b = Buffer.from(hex, 'hex');
        return [hex, b.toString('base64url'), b.toString('base64')];
      }),
    ];
    for (const n of needles) expect(all).not.toContain(n);
    expect(all).not.toMatch(/password|code_hmac|"ref"/);
  });

  it('guards a note that starts with = in the CSV and keeps quotes and line breaks', () => {
    const csv = files['visits.csv'] as string;
    expect(csv.startsWith('museum_id,museum,place,visited_on,note\r\n')).toBe(true);
    expect(csv).toContain(`,"'=HYPERLINK(""https://evil.test"")"\r\n`);
    expect(csv).toContain('"Mooi, met ""quotes"", komma’s\nen een regel"');
    expect((files['wishlist.csv'] as string).split('\r\n')[0]).toBe('museum_id,museum,place,added_on');
  });

  it('writes the bundle 0700 / 0600 and leaves no temporary directory', () => {
    expect(statSync(join(dir, exportId)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, exportId, 'export.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('mails the account link in her locale, with no id, file name or data', async () => {
    const sent = await runJobs(MAIL_EXPORT_JOB);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(alice.email);
    expect(sent[0]?.text).toContain('https://example.test/account\n');
    expect(sent[0]?.text).toContain('24 uur');
    const all = `${sent[0]?.subject}\n${sent[0]?.text}`;
    expect(all).not.toContain(exportId);
    expect(all).not.toMatch(/export\.json|\.csv|HYPERLINK|Mooi/);
  });

  it('a 404 once it expires', async () => {
    await p.owner.query(`UPDATE data_export SET expires_at = now() - interval '1 second' WHERE id = $1`, [exportId]);
    expect((await download(exportId, 'export.json', alice.token)).status).toBe(404);
  });
});

describe('the export mail', () => {
  it('goes in English for an English member, and not at all when the export expired first', async () => {
    const u = await p.newMember({ settings: { locale: 'en' } });
    const token = await app.signIn(u.id);
    await exportOf(token);
    const sent = await runJobs(MAIL_EXPORT_JOB);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('https://example.test/en/account\n');
    expect(sent[0]?.text).toContain('24 hours');

    const v = await p.newMember();
    const vToken = await app.signIn(v.id);
    const id = await exportOf(vToken);
    await p.owner.query(`UPDATE data_export SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await runJobs(MAIL_EXPORT_JOB)).toEqual([]);
  });

  it('the job builds nothing for a row that is gone or no longer queued', async () => {
    const u = await p.newMember();
    const token = await app.signIn(u.id);
    const r = await app.call('/me/exports', { method: 'POST', token });
    const { id } = (await r.json()) as { id: string };
    await p.owner.query(`UPDATE data_export SET state = 'failed' WHERE id = $1`, [id]);
    await runJobs(DATA_EXPORT_JOB);
    expect(readdirSync(dir)).not.toContain(id);
    expect(await runJobs(MAIL_EXPORT_JOB)).toEqual([]);
  });
});

describe('reviews in the export (P3a)', () => {
  it('lists each review with its revisions oldest first, and the importer still reads the file', async () => {
    const u = await p.newMember();
    const m = await p.visible(30);
    const visit = await p.addVisit(u.id, m.id, { on: '2026-02-03' });
    const review = await p.pools.api.query<{ id: string }>(
      `INSERT INTO review (user_id, museum_id, visit_id, rating, collection, body) VALUES ($1, $2, $3, 2, 3, 'Eerste')
       RETURNING id`,
      [u.id, m.id, visit],
    );
    const id = (review.rows[0] as { id: string }).id;
    // Two edits: the revisions hold what each edit replaced (rating 2 first, then 4).
    await p.pools.api.query(
      `INSERT INTO review_revision (review_id, rating, collection, body, created_at)
       VALUES ($1, 4, 5, 'Tweede', now() - interval '1 hour'), ($1, 2, 3, 'Eerste', now() - interval '2 hours')`,
      [id],
    );
    await p.owner.query(
      "UPDATE review SET rating = 5, collection = 5, body = 'Derde', edited_at = now() WHERE id = $1",
      [id],
    );
    const token = await app.signIn(u.id);
    const exportId = await exportOf(token);
    const text = await (await download(exportId, 'export.json', token)).text();
    const doc = JSON.parse(text);
    expect(MjkExportV1.safeParse(doc).success).toBe(true);
    expect(doc.reviews).toHaveLength(1);
    expect(doc.reviews[0]).toMatchObject({
      museum: { id: m.id, slug: m.slug },
      visited_on: '2026-02-03',
      rating: 5,
      collection: 5,
      presentation: null,
      body: 'Derde',
      state: 'visible',
    });
    expect(doc.reviews[0].edited_at).not.toBeNull();
    expect(doc.reviews[0].revisions.map((r: { body: string; rating: number }) => [r.rating, r.body])).toEqual([
      [2, 'Eerste'],
      [4, 'Tweede'],
    ]);
    // The importer reads the file with the key, and without it.
    expect(parseMjk(text, todayAmsterdam())).toMatchObject({ ok: true, rows: [{ kind: 'visit' }] });
    const { reviews: _, ...without } = doc;
    expect(MjkExportV1.safeParse(without).success).toBe(true);
    expect(parseMjk(JSON.stringify(without), todayAmsterdam())).toMatchObject({ ok: true });
  });
});

describe('photos in the export (P3b)', () => {
  it('lists the member’s photos as metadata only: no file, key, hash or other member’s photo', async () => {
    const u = await p.newMember();
    const other = await p.newMember();
    const m = await p.visible(31);
    const visit = await p.addVisit(u.id, m.id, {});
    const review = await p.pools.api.query<{ id: string }>(
      `INSERT INTO review (user_id, museum_id, visit_id, rating) VALUES ($1, $2, $3, 4) RETURNING id`,
      [u.id, m.id, visit],
    );
    const reviewId = (review.rows[0] as { id: string }).id;
    const keys = ['a1'.repeat(16), 'b2'.repeat(16), 'c3'.repeat(16)];
    const sha = Buffer.alloc(32, 0x5a);
    const insert = async (userId: string, state: string, key: string | null, alt: string | null, attach: boolean) =>
      (
        await p.owner.query<{ id: string }>(
          `INSERT INTO media (user_id, museum_id, review_id, type, state, declared_size, chunk_count, sha256, width,
             height, public_key, alt_text, consents_at)
           VALUES ($1, $2, $3, 'image/jpeg', $4, 1000, 1, $5, $6, $7, $8, $9, now()) RETURNING id`,
          [
            userId,
            m.id,
            attach ? reviewId : null,
            state,
            sha,
            key === null ? null : 640,
            key === null ? null : 480,
            key,
            alt,
          ],
        )
      ).rows[0]?.id as string;
    const approved = await insert(u.id, 'approved', keys[0] as string, 'Een zaal', true);
    const pending = await insert(u.id, 'pending_review', keys[1] as string, null, true);
    const loose = await insert(u.id, 'quarantined', null, null, false);
    const theirs = await insert(other.id, 'approved', keys[2] as string, null, false);

    const token = await app.signIn(u.id);
    const text = await (await download(await exportOf(token), 'export.json', token)).text();
    const doc = JSON.parse(text);
    expect(MjkExportV1.safeParse(doc).success).toBe(true);
    expect(doc.photos.map((x: { id: string }) => x.id).sort()).toEqual([approved, pending, loose].sort());
    const one = doc.photos.find((x: { id: string }) => x.id === approved);
    expect(one).toEqual({
      id: approved,
      review_id: reviewId,
      museum_slug: m.slug,
      state: 'approved',
      created_at: expect.any(String),
      alt_text: 'Een zaal',
      width: 640,
      height: 480,
    });
    expect(doc.photos.find((x: { id: string }) => x.id === loose)).toMatchObject({ review_id: null, width: null });
    for (const secret of [...keys, sha.toString('hex'), sha.toString('base64'), theirs, 'public_key', 'sha256'])
      expect(text).not.toContain(secret);
    expect(parseMjk(text, todayAmsterdam())).toMatchObject({ ok: true });
  });
});
