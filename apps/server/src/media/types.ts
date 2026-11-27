import type { VariantFormat } from '@mjk/contracts';

// The seams between the photo packages (P3b plan §2): the worker's handoff to the `media` role (WP3), the variant
// upload (WP4) and the Commons job (WP6b) code against these types only.

/** The job kinds of the photo pipeline (payloads are `{media_id}` only). */
export const MEDIA_PROCESS_JOB = 'media_process';
export const MEDIA_PUBLISH_JOB = 'media_publish';
export const MEDIA_DELETE_JOB = 'media_delete';

/** The formats sharp reads; each must match what file-type found (A§12). */
export type SourceFormat = 'jpeg' | 'png' | 'webp';

/** One encoded variant, read once into memory by the worker and validated there (never re-opened by path). */
export type Variant = { readonly format: VariantFormat; readonly width: number; readonly bytes: Uint8Array };

/** What the `media` role made of one source: its oriented size and the variants, AVIF and WebP per width. */
export type Decoded = { readonly width: number; readonly height: number; readonly variants: readonly Variant[] };

/**
 * Hands one source file to the `media` role and waits for its variants (WP3, `media/handoff.ts`). Throws a
 * `JobError`: retryable when the role never took the task (or the signal aborted), not retryable when the source
 * failed to decode, broke a limit or ran past its budget.
 */
export type Decode = (source: { path: string; expect: SourceFormat }, signal: AbortSignal) => Promise<Decoded>;

/** A variant's R2 key (A§12): `p/<128-bit random hex>/<width>.<ext>`, derived from no id or file name. */
export function variantKey(publicKey: string, format: VariantFormat, width: number): string {
  if (!/^[0-9a-f]{32}$/.test(publicKey) || !Number.isInteger(width) || width < 1 || width > 10_000) {
    throw new Error('variantKey: invalid input');
  }
  return `p/${publicKey}/${width}.${format}`;
}

/** The exact Content-Type of a variant. */
export const VARIANT_CONTENT_TYPE: Readonly<Record<VariantFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
};
