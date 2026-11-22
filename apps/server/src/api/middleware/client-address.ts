import { isIP } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiEnv } from './request.ts';

// The client address (A§9 "Client IP", A§17.2). Caddy trusts only cloudflared's /32, takes the
// right-most untrusted X-Forwarded-For address and sends it as `X-Mjk-Client`. The api believes that
// header only when the TCP peer is caddy itself (10.63.2.10 on mjk-edge); from any other peer (ssr,
// a container that reached the api some other way) the peer's own address is the client, so no one
// but caddy can choose a limiter key. P2a's limiter keys on the prefix (A§9).
//
// Invariant 8: neither the address nor its prefix is ever logged; they live on the context only.

/** caddy's fixed address on mjk-edge (A§17.1, compose). */
export const CADDY_PEER = '10.63.2.10';
export const CLIENT_HEADER = 'x-mjk-client';

export type ClientAddress = {
  /** The canonical address: dotted IPv4 (IPv4-mapped IPv6 unmapped), or compressed lowercase IPv6. */
  address: string;
  /** The limiter key (A§9): the /24 for IPv4, the /56 for IPv6. */
  prefix: string;
  /** IPv6 only: the /48, which P2a limits at 4× the /56's limit [U]; null for IPv4. */
  prefix48: string | null;
};

export type ClientAddressDeps = {
  /** The TCP peer's address: @hono/node-server's conninfo in runApi; tests inject one. */
  peer: (c: Context<ApiEnv>) => string | undefined;
  /** The one peer whose X-Mjk-Client counts (tests inject theirs). */
  trustedPeer?: string;
};

/** An IPv6 literal (isIP() === 6, no zone) as eight 16-bit groups. */
function groups(v6: string): number[] {
  let s = v6.toLowerCase();
  const last = s.lastIndexOf(':');
  const tail = s.slice(last + 1);
  if (tail.includes('.')) {
    // An embedded dotted IPv4 tail (`::ffff:1.2.3.4`) becomes two hex groups.
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    s = `${s.slice(0, last + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const h = head === '' ? [] : head.split(':');
  const r = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  return [...h, ...Array<string>(fill).fill('0'), ...r].map((g) => Number.parseInt(g, 16));
}

/** Eight groups as the WHATWG URL serialiser writes them: lowercase, the longest zero run compressed. */
const formatV6 = (g: readonly number[]): string =>
  new URL(`http://[${g.map((x) => x.toString(16)).join(':')}]`).hostname.slice(1, -1);

/**
 * One IP literal in canonical form, or null when `raw` is not exactly one (whitespace, a list, a
 * port, brackets or a zone id all fail). IPv4-mapped IPv6 (`::ffff:a.b.c.d`) becomes the IPv4.
 */
export function canonicalAddress(raw: string): string | null {
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6 || raw.includes('%')) return null;
  const g = groups(raw);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return formatV6(g);
}

/** The canonical address with its limiter prefixes. `address` must come from canonicalAddress. */
export function withPrefixes(address: string): ClientAddress {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.');
    return { address, prefix: `${a}.${b}.${c}.0/24`, prefix48: null };
  }
  const g = groups(address);
  const z = (keep: number[]) => [...keep, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);
  return {
    address,
    prefix: `${formatV6(z([g[0] ?? 0, g[1] ?? 0, g[2] ?? 0, (g[3] ?? 0) & 0xff00]))}/56`,
    prefix48: `${formatV6(z([g[0] ?? 0, g[1] ?? 0, g[2] ?? 0]))}/48`,
  };
}

/**
 * The address a request comes from, or null when it is unknown. From the trusted peer (caddy) only
 * the header counts, and only when it is one valid IP literal: a missing or invalid header is null,
 * never caddy's own address (every such request would share one limiter key; P1e review S17). From
 * any other peer the peer's own address is the client. A gone peer (a closed socket) is null too.
 */
export function resolveClient(peerRaw: string | undefined, header: string | undefined, trusted: string): string | null {
  const peer = peerRaw === undefined ? null : canonicalAddress(peerRaw);
  if (peer === null) return null;
  if (peer === trusted) return header === undefined ? null : canonicalAddress(header);
  return peer;
}

/**
 * Sets `client` on the context. When the peer is unknown it stays unset: anything that keys on the
 * client (P2a's limiter) must then refuse, never fall back to a shared key.
 */
export function clientAddress(deps: ClientAddressDeps): MiddlewareHandler<ApiEnv> {
  const trusted = deps.trustedPeer ?? CADDY_PEER;
  return async (c, next) => {
    let peer: string | undefined;
    try {
      peer = deps.peer(c);
    } catch {
      peer = undefined;
    }
    const address = resolveClient(peer, c.req.header(CLIENT_HEADER), trusted);
    if (address !== null) c.set('client', withPrefixes(address));
    await next();
  };
}
