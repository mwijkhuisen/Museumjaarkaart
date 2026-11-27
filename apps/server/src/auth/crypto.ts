import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

// Pure node:crypto primitives for accounts (A§9): peppered HMACs, session tokens, codes and
// AES-256-GCM sealing of the values that mail jobs carry. No I/O, no dependency.

/** HMAC-SHA256 over the parts, each prefixed with its byte length (4 bytes, big-endian). */
export function hmac(key: Buffer, ...parts: readonly (string | Buffer)[]): Buffer {
  const h = createHmac('sha256', key);
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    h.update(len).update(bytes);
  }
  return h.digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url without padding (43 characters). */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/**
 * The session row id: sha256 of the token's 32 decoded bytes, or null for anything that is not
 * a token we could have issued (the round trip also refuses one whose spare low bits are set,
 * so each token has exactly one spelling).
 */
export function sessionTokenHash(token: string): Buffer | null {
  if (!TOKEN_RE.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) return null;
  return sha256(bytes);
}

export const sixDigitCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 characters of Crockford base32 from 10 random bytes: 80 bits, 5 per character, no bias. */
export function newInviteCode(): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of randomBytes(10)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;
const BODY_RE = /^[A-Za-z0-9_-]+$/;
const TAG_BYTES = 16;

/** AES-256-GCM with a fresh 12-byte nonce: `v1.<nonce>.<ciphertext‖tag>`, both base64url. */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

/** The plaintext, or null on any problem (format, version, key, nonce, ciphertext, tag, aad). Never throws. */
export function open(key: Buffer, sealed: string, aad: string): string | null {
  try {
    const parts = sealed.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || key.length !== 32) return null;
    const [, n, b] = parts as [string, string, string];
    if (!NONCE_RE.test(n) || !BODY_RE.test(b)) return null;
    const nonce = Buffer.from(n, 'base64url');
    const body = Buffer.from(b, 'base64url');
    if (nonce.length !== 12 || body.length < TAG_BYTES || body.toString('base64url') !== b) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}
