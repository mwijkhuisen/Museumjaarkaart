import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4, header-based, with a signed payload (the S3 developer guide,
// "Signature Calculations for the Authorization Header: Transferring Payload in a Single Chunk").
// Pure: no I/O, and the clock is a parameter. The R2 client (media/r2.ts) is its caller.
// The signer encodes the path and the query itself, once, and returns the encoded target, so
// what is sent is exactly what was signed (S3 paths are never double-encoded or normalised).

export type Credentials = { readonly accessKeyId: string; readonly secretAccessKey: string };

export type SigV4Request = {
  method: string;
  /** The Host header as it is sent: the host name, plus `:port` when it is not the default. */
  host: string;
  /** The raw path, from `/`, not encoded: each segment is encoded here. */
  path: string;
  /** Raw query parameters, not encoded; a subresource (`uploads`, `policy`) has the value ''. */
  query?: Readonly<Record<string, string>> | undefined;
  /** Further headers to sign and send. `host`, `x-amz-date` and (for s3) `x-amz-content-sha256` are set here. */
  headers?: Readonly<Record<string, string>> | undefined;
  body?: Uint8Array | string | undefined;
};

export type Scope = { region: string; service: string };

export type Signed = {
  /** The encoded path and query string to append to the origin. */
  target: string;
  /** The headers to send, Authorization included. Host is left out: fetch sets it from the URL. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
};

export const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data).digest();

/** S3's UriEncode: every UTF-8 byte except A-Z a-z 0-9 - . _ ~ becomes %XX (upper case). Throws URIError on a lone surrogate. */
export function uriEncode(s: string): string {
  // encodeURIComponent keeps ! ' ( ) * as well, which RFC 3986 reserves.
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The path with each segment encoded and `/` kept. */
export const canonicalUri = (path: string): string => (path === '' ? '/' : path.split('/').map(uriEncode).join('/'));

/** Name and value encoded, then sorted by the encoded name. */
export function canonicalQuery(query: Readonly<Record<string, string>> = {}): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** The SigV4 signing key: HMAC-SHA256 from `AWS4<secret>` through the date, region, service and `aws4_request`. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** `20130524T000000Z` */
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, '');

export function sign(req: SigV4Request, creds: Credentials, scope: Scope, now: Date): Signed {
  const date = amzDate(now);
  const payloadHash = sha256Hex(req.body ?? '');
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  headers.delete('authorization');
  headers.set('host', req.host);
  headers.set('x-amz-date', date);
  // S3 wants the payload hash as a header too; the other services take it from the canonical request only.
  if (scope.service === 's3') headers.set('x-amz-content-sha256', payloadHash);
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const uri = canonicalUri(req.path);
  const query = canonicalQuery(req.query);
  const canonicalRequest = [
    req.method,
    uri,
    query,
    names.map((n) => `${n}:${headers.get(n)}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${date.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const key = signingKey(creds.secretAccessKey, date.slice(0, 8), scope.region, scope.service);
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.delete('host');
  headers.set(
    'authorization',
    `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  );
  return {
    target: query === '' ? uri : `${uri}?${query}`,
    headers: Object.fromEntries(headers),
    canonicalRequest,
    stringToSign,
    signature,
  };
}
