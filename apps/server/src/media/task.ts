import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PHOTO_MAX_PIXELS } from './limits.ts';

// The task format between the worker (media/handoff.ts) and the `media` role (media/role.ts), on the shared mount
// /srv/mjk/media-work (P3b plan §2 "Processing"). One directory per task, flat fixed names only. Neither side
// imports the other: both import this file, which loads neither sharp nor anything of the database.

/** The fixed names in a task directory. The worker writes the first three; the role renames `ready` to `taken`. */
export const TASK = {
  input: 'in',
  spec: 'in.json',
  ready: 'ready',
  taken: 'taken',
  result: 'result.json',
} as const;

/** A variant's fixed file name, in a task directory and in quarantine's `<id>/v/`. */
export const variantName = (format: 'avif' | 'webp', width: number): string => `${width}.${format}`;

/** The decoder's own failures (media/process.ts); none is retried. */
export const DECODE_CODES = [
  'media_too_many_pixels',
  'media_format_mismatch',
  'media_decode_failed',
  'media_timeout',
] as const;
export type DecodeCode = (typeof DECODE_CODES)[number];
/** The role stopped (SIGTERM) before it finished: the job is retried. */
export const ABORTED_CODE = 'media_aborted';

export const TaskSpec = z.strictObject({ expect: z.enum(['jpeg', 'png', 'webp']) });

const Size = z.int().min(1).max(100_000);

export const TaskResult = z.discriminatedUnion('ok', [
  z
    .strictObject({
      ok: z.literal(true),
      width: Size,
      height: Size,
      files: z.array(z.strictObject({ format: z.enum(['avif', 'webp']), width: z.int().min(1).max(2000) })).max(8),
    })
    .refine((r) => r.width * r.height <= PHOTO_MAX_PIXELS),
  z.strictObject({ ok: z.literal(false), code: z.enum([...DECODE_CODES, ABORTED_CODE]) }),
]);
export type TaskResult = z.infer<typeof TaskResult>;

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Writes `name` through a temporary name and a rename, so the worker never sees half a file. */
export async function writeAtomic(dir: string, name: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  const fh = await open(tmp, CREATE, 0o600);
  try {
    await fh.writeFile(bytes);
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, name));
}

export const writeResult = (dir: string, result: TaskResult) => writeAtomic(dir, TASK.result, JSON.stringify(result));
