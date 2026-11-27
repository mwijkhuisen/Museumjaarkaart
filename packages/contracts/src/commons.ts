// Links and labels for a Wikimedia Commons image's licence (ADR-0018). Browser-safe, no I/O:
// the page shows these as links and text; the browser never requests them itself.

const CC_CODE = /^cc-by(-sa)?-(1\.0|2\.0|2\.5|3\.0|4\.0)(?:-([a-z]{2}))?$/;

/** The licence deed of an allowed `museum_image.licence` code, or null for a code we do not know. */
export function licenceDeedUrl(code: string): string | null {
  if (code === 'cc0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (code === 'pd') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  const m = CC_CODE.exec(code);
  if (m === null) return null;
  return `https://creativecommons.org/licenses/${m[1] === undefined ? 'by' : 'by-sa'}/${m[2]}/${m[3] === undefined ? '' : `${m[3]}/`}`;
}

/** `CC0`, `CC BY-SA 4.0`, `CC BY 3.0 NL`; null for `pd` (the page shows its own NL/EN words) and unknown codes. */
export function licenceShortName(code: string): string | null {
  if (code === 'cc0') return 'CC0';
  const m = CC_CODE.exec(code);
  if (m === null) return null;
  return `CC BY${m[1] === undefined ? '' : '-SA'} ${m[2]}${m[3] === undefined ? '' : ` ${m[3].toUpperCase()}`}`;
}

/** The Commons page of a file (a link-out): spaces as underscores, percent-encoded. */
export function commonsFilePageUrl(file: string): string {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replaceAll(' ', '_'))}`;
}
