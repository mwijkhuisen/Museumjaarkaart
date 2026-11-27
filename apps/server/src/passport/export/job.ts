import type { ASPECTS, ExportFile } from '@mjk/contracts';
import { sql } from 'kysely';
import { z } from 'zod';
import { settingsOf } from '../../auth/me.ts';
import type { Db } from '../../db/kysely.ts';
import { MAIL_EXPORT_JOB } from '../../mail/payloads.ts';
import { escapeCell, writeCsv } from '../../museums/csv.ts';
import { enqueueIn } from '../../worker/queue.ts';
import { JobError, type JobHandler } from '../../worker/types.ts';
import { MjkExportV1, VISITS_CSV_HEADER, WISHLIST_CSV_HEADER } from '../mjk-format.ts';
import { writeBundle } from './files.ts';

// The `data_export` job (A§10, P2c criterion 8), as mjk_worker: every row that holds the member's id or email
// by P2c (P2b's passkeys as metadata only), as `export.json` (the `mjk` v1 format) and the two CSVs, then the row turns `ready` for 24 h [U] and
// the mail job is queued in the same transaction. The worker's column grants keep every secret out: it cannot
// read the password hash, a code HMAC or a session id. A failure leaves the row `queued`; the purge marks it
// `failed` after an hour, so the member can ask again.

export const DATA_EXPORT_JOB = 'data_export';

const Payload = z.strictObject({ export_id: z.uuid() });

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

type MuseumCols = { museum_id: string; slug: string; name: string; place: string | null; wikidata_qid: string | null };
const museumOf = (r: MuseumCols) => ({
  id: r.museum_id,
  slug: r.slug,
  name: r.name,
  place: r.place,
  wikidata_qid: r.wikidata_qid,
});

type ReviewContent = { rating: number; body: string | null } & Record<(typeof ASPECTS)[number], number | null>;
const contentOf = (r: ReviewContent) => ({
  rating: r.rating,
  collection: r.collection,
  presentation: r.presentation,
  kid_friendly: r.kid_friendly,
  accessibility: r.accessibility,
  facilities: r.facilities,
  value_for_money: r.value_for_money,
  body: r.body,
});

/** The bundle's three files for one member. */
export async function buildBundle(db: Db, userId: string): Promise<Record<ExportFile, string>> {
  const u = await db
    .selectFrom('app_user')
    .select([
      'handle',
      'display_name',
      'email',
      'created_at',
      'email_verified_at',
      'age_confirmed_at',
      'terms_version',
      'terms_accepted_at',
      'settings',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (u === undefined) throw new JobError('export_user_gone', { retry: false });

  // The museum from `museum` itself: a museum hidden since the visit still has its name.
  const visits = (
    await sql<MuseumCols & { visited_on: string | null; note: string | null; source: string; created_at: Date }>`
      SELECT v.visited_on::text AS visited_on, v.note, v.source, v.created_at,
             m.id AS museum_id, m.slug, m.name, m.place, m.wikidata_qid
        FROM visit v JOIN museum m ON m.id = v.museum_id
       WHERE v.user_id = ${userId}::uuid
       ORDER BY v.visited_on DESC NULLS LAST, v.id DESC`.execute(db)
  ).rows;
  const wishlist = (
    await sql<MuseumCols & { created_at: Date; added_on: string }>`
      SELECT w.created_at, (w.created_at AT TIME ZONE 'Europe/Amsterdam')::date::text AS added_on,
             m.id AS museum_id, m.slug, m.name, m.place, m.wikidata_qid
        FROM wishlist w JOIN museum m ON m.id = w.museum_id
       WHERE w.user_id = ${userId}::uuid
       ORDER BY w.created_at, w.museum_id`.execute(db)
  ).rows;
  // Every review of the member, any state (a removed one is still theirs), with its revisions, oldest first.
  const reviewRows = (
    await sql<
      MuseumCols & {
        id: string;
        visited_on: string | null;
        state: 'visible' | 'removed';
        created_at: Date;
        edited_at: Date | null;
      } & ReviewContent
    >`SELECT r.id, v.visited_on::text AS visited_on, r.rating, r.collection, r.presentation, r.kid_friendly,
             r.accessibility, r.facilities, r.value_for_money, r.body, r.state, r.created_at, r.edited_at,
             m.id AS museum_id, m.slug, m.name, m.place, m.wikidata_qid
        FROM review r JOIN museum m ON m.id = r.museum_id LEFT JOIN visit v ON v.id = r.visit_id
       WHERE r.user_id = ${userId}::uuid
       ORDER BY r.created_at, r.id`.execute(db)
  ).rows;
  const revisionRows = (
    await sql<{ review_id: string; created_at: Date } & ReviewContent>`
      SELECT q.review_id, q.rating, q.collection, q.presentation, q.kid_friendly, q.accessibility, q.facilities,
             q.value_for_money, q.body, q.created_at
        FROM review_revision q JOIN review r ON r.id = q.review_id
       WHERE r.user_id = ${userId}::uuid
       ORDER BY q.created_at, q.id`.execute(db)
  ).rows;
  // Every photo of the member, any state, as metadata: never the file, the public key, the hash or the error.
  const photos = (
    await sql<{
      id: string;
      review_id: string | null;
      slug: string;
      state: string;
      created_at: Date;
      alt_text: string | null;
      width: number | null;
      height: number | null;
    }>`SELECT md.id, md.review_id, m.slug, md.state, md.created_at, md.alt_text, md.width, md.height
        FROM media md JOIN museum m ON m.id = md.museum_id
       WHERE md.user_id = ${userId}::uuid
       ORDER BY md.created_at, md.id`.execute(db)
  ).rows;
  const sessions = await db
    .selectFrom('session')
    .select(['host', 'method', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const passkeys = await db
    .selectFrom('passkey')
    .select(['name', 'transports', 'backed_up', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const imports = await db
    .selectFrom('visit_import')
    .select(['format', 'state', 'created_at', 'confirmed_at', 'rows'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const exports = await db
    .selectFrom('data_export')
    .select(['state', 'created_at', 'expires_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  const ipLog = await db
    .selectFrom('content_ip_log')
    .select(['target_kind', 'target_id', 'ip', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();

  // Parsed against the format before anything is written: a shape that drifted fails the job, not the reader.
  const parsed = MjkExportV1.safeParse({
    format: 'mjk',
    version: 1,
    exported_at: new Date().toISOString(),
    account: {
      handle: u.handle,
      display_name: u.display_name,
      email: u.email,
      created_at: u.created_at.toISOString(),
      email_verified_at: iso(u.email_verified_at),
      age_confirmed_at: iso(u.age_confirmed_at),
      terms_version: u.terms_version,
      terms_accepted_at: iso(u.terms_accepted_at),
      settings: settingsOf(u.settings),
    },
    visits: visits.map((v) => ({
      museum: museumOf(v),
      visited_on: v.visited_on,
      note: v.note,
      source: v.source,
      created_at: v.created_at.toISOString(),
    })),
    wishlist: wishlist.map((w) => ({ museum: museumOf(w), created_at: w.created_at.toISOString() })),
    reviews: reviewRows.map((r) => ({
      museum: museumOf(r),
      visited_on: r.visited_on,
      ...contentOf(r),
      state: r.state,
      created_at: r.created_at.toISOString(),
      edited_at: iso(r.edited_at),
      revisions: revisionRows
        .filter((q) => q.review_id === r.id)
        .map((q) => ({ ...contentOf(q), created_at: q.created_at.toISOString() })),
    })),
    photos: photos.map((p) => ({
      id: p.id,
      review_id: p.review_id,
      museum_slug: p.slug,
      state: p.state,
      created_at: p.created_at.toISOString(),
      alt_text: p.alt_text,
      width: p.width,
      height: p.height,
    })),
    sessions: sessions.map((s) => ({
      host: s.host,
      method: s.method,
      created_at: s.created_at.toISOString(),
      last_used_at: s.last_used_at.toISOString(),
    })),
    passkeys: passkeys.map((k) => ({
      name: k.name,
      transports: k.transports,
      backed_up: k.backed_up,
      created_at: k.created_at.toISOString(),
      last_used_at: iso(k.last_used_at),
    })),
    imports: imports.map((i) => ({
      format: i.format,
      state: i.state,
      created_at: i.created_at.toISOString(),
      confirmed_at: iso(i.confirmed_at),
      rows: i.rows,
    })),
    exports: exports.map((e) => ({
      state: e.state,
      created_at: e.created_at.toISOString(),
      expires_at: iso(e.expires_at),
    })),
    content_ip_log: ipLog.map((l) => ({
      target_kind: l.target_kind,
      target_id: l.target_id,
      ip: l.ip,
      created_at: l.created_at.toISOString(),
    })),
  });
  if (!parsed.success) throw new JobError('export_invalid', { retry: false });

  // Museum names come from Wikidata and notes from members: every cell is guarded against formulas.
  const cells = (row: readonly (string | null)[]) => row.map((v) => escapeCell(v ?? ''));
  return {
    'export.json': `${JSON.stringify(parsed.data, null, 2)}\n`,
    'visits.csv': writeCsv([
      [...VISITS_CSV_HEADER],
      ...visits.map((v) => cells([v.museum_id, v.name, v.place, v.visited_on, v.note])),
    ]),
    'wishlist.csv': writeCsv([
      [...WISHLIST_CSV_HEADER],
      ...wishlist.map((w) => cells([w.museum_id, w.name, w.place, w.added_on])),
    ]),
  };
}

export function dataExportJob(deps: { db: Db; exportsDir: string }): JobHandler {
  const { db, exportsDir } = deps;
  return async (payload) => {
    const p = Payload.safeParse(payload);
    if (!p.success) throw new JobError('export_payload_invalid', { retry: false });
    const id = p.data.export_id;
    // Gone with its account, or already done or failed: nothing to build.
    const row = await db.selectFrom('data_export').select(['user_id', 'state']).where('id', '=', id).executeTakeFirst();
    if (row === undefined || row.state !== 'queued') return 'consumed';

    const files = await buildBundle(db, row.user_id);
    try {
      await writeBundle(exportsDir, id, files);
    } catch {
      throw new JobError('export_write_failed');
    }

    await db.transaction().execute(async (trx) => {
      const ready = await trx
        .updateTable('data_export')
        .set({ state: 'ready', expires_at: sql<Date>`now() + interval '24 hours'` })
        .where('id', '=', id)
        .where('state', '=', 'queued')
        .executeTakeFirst();
      // Marked failed by the purge meanwhile, or deleted: no mail; the purge removes the files.
      if (ready.numUpdatedRows === 0n) return;
      const user = await trx.selectFrom('app_user').select('settings').where('id', '=', row.user_id).executeTakeFirst();
      await enqueueIn(
        trx,
        MAIL_EXPORT_JOB,
        { user_id: row.user_id, export_id: id, locale: settingsOf(user?.settings).locale },
        {},
      );
    });
  };
}
