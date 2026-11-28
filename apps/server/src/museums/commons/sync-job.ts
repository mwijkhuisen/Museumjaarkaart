import { setTimeout as sleepFor } from 'node:timers/promises';
import { sql } from 'kysely';
import { r2Of } from '../../media/publish.ts';
import { enqueueIn } from '../../worker/queue.ts';
import { JobError, type JobHandler } from '../../worker/types.ts';
import { fetchJson } from '../sources/http.ts';
import { imageInfoUrl, MAX_FILES_PER_REQUEST, parseImageInfo } from './api.ts';
import { type CommonsDeps, httpOf } from './image-job.ts';
import { COMMONS_IMAGE_JOB, deleteKeys, imageKeys, judge, type Present, writeSkipped } from './store.ts';

// The weekly `commons_sync` job (ADR-0018): one imageinfo request per 50 files, 2 s apart, then per museum a
// verdict. A new file, a new sha1 or a changed licence or credit queues `commons_image` (10 s apart, so the
// `media` role works through them one by one); a deleted file or a licence that left the allowlist removes our
// copy here; a museum without a `commons_file` loses its row. A `hidden` row is never touched. Counts only.

export const REQUEST_GAP_MS = 2000;
export const IMAGE_STAGGER_MS = 10_000;
/** What a skipped row that only a later change can fix looks like: the verdict is worth asking again. */
const RETRYABLE_SKIPS = new Set([
  'commons_licence_missing',
  'commons_licence_not_allowed',
  'commons_attribution_missing',
  'commons_file_missing',
  'commons_hidden',
  'commons_restricted',
]);

type Counts = Record<'museums' | 'queued' | 'removed' | 'skipped' | 'unchanged' | 'invalid' | 'failed', number>;

export function commonsSyncJob(d: CommonsDeps & { sleep?: (ms: number) => Promise<void> }): JobHandler {
  const { db } = d;
  const http = httpOf(d);
  const sleep = d.sleep ?? ((ms: number) => sleepFor(ms));
  return async (_payload, { signal }) => {
    const counts: Counts = { museums: 0, queued: 0, removed: 0, skipped: 0, unchanged: 0, invalid: 0, failed: 0 };

    // A museum that lost its file: our copy and its row go (a hidden row too: there is nothing left to hide).
    const gone = await db
      .selectFrom('museum_image as i')
      .innerJoin('museum as m', 'm.id', 'i.museum_id')
      .select(['i.museum_id', 'i.public_key', 'i.widths'])
      .where('m.commons_file', 'is', null)
      .execute();
    for (const g of gone) {
      // The row first, then the objects (ADR-0018): a page never names a deleted object.
      await db.deleteFrom('museum_image').where('museum_id', '=', g.museum_id).execute();
      if (g.public_key !== null) await deleteKeys(r2Of(d), imageKeys(g.public_key, g.widths ?? []), signal);
      counts.removed++;
    }

    const museums = await db
      .selectFrom('museum as m')
      .leftJoin('museum_image as i', 'i.museum_id', 'm.id')
      .select([
        'm.id',
        'm.commons_file as file',
        'i.state',
        'i.file as row_file',
        'i.sha1',
        'i.licence',
        'i.attribution',
        'i.skip_code',
      ])
      .where('m.commons_file', 'is not', null)
      .where('m.hidden', '=', false)
      .orderBy('m.id')
      .execute();
    counts.museums = museums.length;
    const files = [...new Set(museums.map((m) => m.file as string))];

    const info = new Map<string, Present | 'missing' | 'invalid'>();
    for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
      if (i > 0) await sleep(REQUEST_GAP_MS);
      const batch = files.slice(i, i + MAX_FILES_PER_REQUEST);
      const res = await fetchJson(imageInfoUrl(batch), {}, http);
      const parsed = res.ok ? parseImageInfo(res.body, batch) : undefined;
      if (parsed === undefined || !parsed.ok) {
        counts.failed += batch.length;
        continue;
      }
      for (const r of parsed.results) info.set(r.file, r.state === 'present' ? r : r.state);
    }

    let slot = 0;
    const queue = async (museumId: string) => {
      const open = await db
        .selectFrom('job')
        .select('id')
        .where('kind', '=', COMMONS_IMAGE_JOB)
        .where('state', 'in', ['queued', 'running'])
        .where(sql`payload ->> 'museum_id'`, '=', museumId)
        .limit(1)
        .executeTakeFirst();
      if (open !== undefined) return;
      await enqueueIn(
        db,
        COMMONS_IMAGE_JOB,
        { museum_id: museumId },
        { runAt: new Date(Date.now() + slot++ * IMAGE_STAGGER_MS) },
      );
      counts.queued++;
    };

    for (const m of museums) {
      const file = m.file as string;
      if (m.state === 'hidden') continue;
      const got = info.get(file);
      if (got === undefined) continue; // its batch failed: counted
      if (got === 'invalid') {
        counts.invalid++;
        continue;
      }
      const same = m.row_file === file;
      if (got === 'missing') {
        if (m.state === 'skipped' && same && m.skip_code === 'commons_file_missing') counts.unchanged++;
        else {
          await writeSkipped(db, d, m.id, file, null, 'commons_file_missing', signal);
          counts.removed++;
        }
        continue;
      }
      const verdict = judge(got);
      if (!verdict.ok) {
        if (m.state === 'skipped' && same && m.sha1 === got.sha1 && m.skip_code === verdict.code) counts.unchanged++;
        else {
          await writeSkipped(db, d, m.id, file, got.sha1, verdict.code, signal);
          counts.skipped++;
        }
        continue;
      }
      const changed =
        m.state === null ||
        !same ||
        m.sha1 !== got.sha1 ||
        (m.state === 'skipped' && RETRYABLE_SKIPS.has(m.skip_code ?? '')) ||
        (m.state === 'active' && (m.licence !== verdict.licence || m.attribution !== verdict.attribution));
      if (changed) await queue(m.id);
      else counts.unchanged++;
    }

    d.logger?.info(counts, 'commons_sync_done');
    // A batch that failed is tried again by the job's retry; the rest of the run is idempotent.
    if (counts.failed > 0) throw new JobError('commons_batch_failed', { retry: true });
  };
}
