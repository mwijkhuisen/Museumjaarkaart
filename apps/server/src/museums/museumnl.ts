// The one allowed museum.nl reference: the per-museum link-out host (A§7.1).
// Never fetched (it is not in the HTTP allowlist); stored as a link and a hint.

export const MUSEUMNL_HOST = 'www.museum.nl';

/** An https URL on exactly the link-out host, at most 2,048 characters, or undefined. */
export function museumnlUrl(value: string): string | undefined {
  if (value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== MUSEUMNL_HOST || url.username || url.password || url.port) {
    return undefined;
  }
  return url.href;
}
