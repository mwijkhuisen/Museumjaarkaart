// The Commons licence allowlist (ADR-0018, A§12). Fail closed: anything not matched is skipped.
// This regex is also the `museum_image.licence` CHECK of the migration; keep them equal.

export const LICENCE_RE = /^(cc0|pd|cc-by(-sa)?-(1\.0|2\.0|2\.5|3\.0|4\.0)(-[a-z]{2})?)$/;

export type LicenceResult =
  | { ok: true; code: string }
  | { ok: false; code: 'commons_licence_not_allowed' | 'commons_licence_missing' };

/** `extmetadata.License.value` (e.g. `cc-by-sa-4.0`) to an allowed code, or a fixed skip code. */
export function licenceCode(raw: string | null | undefined): LicenceResult {
  const code = raw?.trim().toLowerCase();
  if (code === undefined || code === '') return { ok: false, code: 'commons_licence_missing' };
  return LICENCE_RE.test(code) ? { ok: true, code } : { ok: false, code: 'commons_licence_not_allowed' };
}
