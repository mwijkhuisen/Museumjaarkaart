import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/kysely.ts';
import { enqueueIn } from '../worker/queue.ts';
import { JobError, type JobHandler } from '../worker/types.ts';
import { removeUpload, uploadPath, variantsDir } from './files.ts';
import { removeTree } from './remove-tree.ts';
import { variantName } from './task.ts';
import { type Decode, type Decoded, MEDIA_PUBLISH_JOB, type SourceFormat, variantKey } from './types.ts';

// The `media_process` job (A§12; plan §2 "State machine", "Processing"): quarantined → processing → the `media`
// role → pending_review with its variants in quarantine's `<id>/v/`. Every transition is guarded by the state it
// leaves; 0 rows means someone else moved the photo (a delete, the purge): this run cleans up what it made and
// stops. A final failure marks the photo `failed` and deletes the upload; a retryable one puts it back.

const Payload = z.strictObject({ media_id: z.uuid() });

const FORMAT: Readonly<Record<string, SourceFormat>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

async function writeVariants(dir: string, decoded: Decoded): Promise<void> {
  // A run that died after writing them left a directory: its files are this photo's own, made by us.
  await removeTree(dir);
  await mkdir(dir, { mode: 0o700 });
  for (const v of decoded.variants) {
    const fh = await open(join(dir, variantName(v.format, v.width)), CREATE, 0o600);
    try {
      await fh.writeFile(v.bytes);
    } finally {
      await fh.close();
    }
  }
}

export function mediaProcessJob(deps: { db: Db; quarantineDir: string; decode: Decode }): JobHandler {
  const { db, quarantineDir: root, decode } = deps;
  /** processing → `to`; false when someone else moved the photo. */
  const leave = (id: string, to: 'quarantined' | 'failed', code?: string) =>
    db
      .updateTable('media')
      .set({ state: to, ...(code === undefined ? {} : { error_code: code }) })
      .where('id', '=', id)
      .where('state', '=', 'processing')
      .executeTakeFirst()
      .then((r) => r.numUpdatedRows > 0n);

  return async (payload, { signal }) => {
    const p = Payload.safeParse(payload);
    if (!p.success) throw new JobError('media_payload_invalid', { retry: false });
    const id = p.data.media_id;

    // `processing` too: a worker that died mid-job left it there, and this job is the only one for the photo.
    const row = await db
      .updateTable('media')
      .set({ state: 'processing' })
      .where('id', '=', id)
      .where('state', 'in', ['quarantined', 'processing'])
      .returning('type')
      .executeTakeFirst();
    if (row === undefined) return;
    const expect = FORMAT[row.type];
    if (expect === undefined) throw new JobError('media_payload_invalid', { retry: false });

    let decoded: Decoded;
    try {
      decoded = await decode({ path: uploadPath(root, id), expect }, signal);
    } catch (err) {
      if (err instanceof JobError && !err.retry) {
        if (!(await leave(id, 'failed', err.code))) return;
        await removeUpload(root, id);
      } else if (!(await leave(id, 'quarantined'))) {
        return;
      }
      throw err;
    }

    const dir = variantsDir(root, id);
    await writeVariants(dir, decoded);
    const publicKey = randomBytes(16).toString('hex');
    const moved = await db.transaction().execute(async (trx) => {
      const m = await trx
        .updateTable('media')
        .set({ state: 'pending_review', width: decoded.width, height: decoded.height, public_key: publicKey })
        .where('id', '=', id)
        .where('state', '=', 'processing')
        .returning(['user_id', 'review_id'])
        .executeTakeFirst();
      if (m === undefined) return false;
      await trx
        .insertInto('media_variant')
        .values(
          decoded.variants.map((v) => ({
            media_id: id,
            format: v.format,
            width: v.width,
            object_key: variantKey(publicKey, v.format, v.width),
            bytes: v.bytes.byteLength,
          })),
        )
        .execute();
      // Only an attached photo is published (plan §1 N1); attaching a processed one enqueues it there (WP5).
      if (m.review_id !== null) {
        const owner = await trx
          .selectFrom('app_user')
          .select(['trusted_at', 'status'])
          .where('id', '=', m.user_id)
          .executeTakeFirst();
        if (owner?.trusted_at != null && owner.status === 'active')
          await enqueueIn(trx, MEDIA_PUBLISH_JOB, { media_id: id }, {});
      }
      return true;
    });
    if (!moved) await removeTree(dir);
  };
}
