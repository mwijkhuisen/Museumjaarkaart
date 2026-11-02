// The one HTTP helper of the museum sync (plan §2.2, §2.7), on the global fetch.
// The real control against SSRF and drift: a request goes only to a host in
// ALLOWED_HOSTS, over https, with no redirect followed, a timeout and a body cap.
// Nothing in a result or a log ever carries the response text, the URL or an error message.

import { setTimeout as sleepFor } from 'node:timers/promises';
import type { SourceErrorCode } from './types.ts';

/** The only hosts the sync talks to. No Commons host in P1a (plan §2.9); the link-out host is never fetched. */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze(['query.wikidata.org', 'services.rce.geovoorziening.nl']);

export const REPO_URL = 'https://github.com/mwijkhuisen/Museumjaarkaart';
export const USER_AGENT_PRODUCT = 'mjk-museum-sync/1.0';
export const DEFAULT_TIMEOUT_MS = 90_000;
/** [U] 20 MB: the full Wikidata answer is a few hundred kB; RCE's about 300 kB. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_TRIES = 3;
export const RETRY_AFTER_CAP_MS = 600_000;
/** The wait before try 2 and try 3 when the answer has no usable Retry-After. */
export const BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000]);

export type HttpDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /** MJK_SYNC_CONTACT: an https URL or an email address. Config, not a secret; never logged. */
  contact?: string;
};

export type FetchInit = {
  method?: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: string;
};

export type FetchJsonResult =
  | { ok: true; body: unknown; ms: number; bytes: number }
  | { ok: false; code: SourceErrorCode };

const URL_CONTACT = /^https:\/\/[^\s<>()]+$/;
const EMAIL_CONTACT = /^[^\s@<>()]+@[^\s@<>()]+$/;

/** An https URL or an email-like value, printable ASCII, at most 200 characters. */
export function validContact(contact: string | undefined): contact is string {
  if (contact === undefined || contact.length === 0 || contact.length > 200 || !/^[\x21-\x7E]+$/.test(contact)) {
    return false;
  }
  if (contact.startsWith('https://')) return URL_CONTACT.test(contact) && URL.canParse(contact);
  return EMAIL_CONTACT.test(contact);
}

/** The User-Agent of every request; a valid contact replaces the repository URL. */
export function userAgent(contact?: string): string {
  return `${USER_AGENT_PRODUCT} (+${validContact(contact) ? contact : REPO_URL})`;
}

/** The parsed URL when it is https, has no port or credentials and its host is allowed; else undefined. */
export function allowedUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return undefined;
  return ALLOWED_HOSTS.includes(url.hostname) ? url : undefined;
}

/** How long to wait before the next try: Retry-After (seconds or an HTTP date, capped), else the backoff. */
export function retryWaitMs(retryAfter: string | null, attempt: number, nowMs: number): number {
  if (retryAfter !== null) {
    const header = retryAfter.trim();
    if (/^[0-9]+$/.test(header)) return Math.min(Number(header) * 1000, RETRY_AFTER_CAP_MS);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - nowMs), RETRY_AFTER_CAP_MS);
  }
  return BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 60_000;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body is not read anyway.
  }
}

/** The body's bytes, or null once it passes `maxBytes` (the stream is cancelled). */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array): unknown {
  // Fatal: invalid UTF-8 is not JSON. A parse error is mapped to not_json by the caller.
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/**
 * One JSON request with the sync's guards. Never throws. 429 and 503 are retried
 * up to MAX_TRIES tries in total; every other failure is final.
 */
export async function fetchJson(url: string, init: FetchInit = {}, deps: HttpDeps = {}): Promise<FetchJsonResult> {
  const target = allowedUrl(url);
  if (target === undefined) return { ok: false, code: 'host_not_allowed' };

  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => sleepFor(ms));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = now();
  // The User-Agent is ours; a caller cannot replace it.
  const headers = { ...init.headers, 'User-Agent': userAgent(deps.contact) };

  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(target.href, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        // Never follow: a redirect could leave the allowlist. Node returns the 3xx as it is.
        redirect: 'manual',
        signal,
      });
    } catch {
      return { ok: false, code: signal.aborted ? 'timeout' : 'network' };
    }

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await discard(res);
      return { ok: false, code: 'redirect' };
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfter = res.headers.get('retry-after');
      await discard(res);
      if (attempt >= MAX_TRIES) return { ok: false, code: 'rate_limited' };
      await sleep(retryWaitMs(retryAfter, attempt, now()));
      continue;
    }
    if (!res.ok) {
      await discard(res);
      return { ok: false, code: 'http_status' };
    }

    const declared = res.headers.get('content-length');
    if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
      await discard(res);
      return { ok: false, code: 'too_large' };
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(res, maxBytes);
    } catch {
      return { ok: false, code: signal.aborted ? 'timeout' : 'network' };
    }
    if (bytes === null) return { ok: false, code: 'too_large' };
    try {
      return { ok: true, body: parseJson(bytes), ms: now() - started, bytes: bytes.byteLength };
    } catch {
      return { ok: false, code: 'not_json' };
    }
  }
}
