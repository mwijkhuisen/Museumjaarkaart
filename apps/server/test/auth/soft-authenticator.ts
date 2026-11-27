import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type { PasskeyAssertion, PasskeyAttestation } from '@mjk/contracts';

// A software authenticator for the P2b tests: it makes WebAuthn registration and authentication
// responses the way a browser and an authenticator would (attestation `none`, ES256 or EdDSA), with a
// knob for every field a check looks at, so a test can forge exactly one wrong thing. The projected
// shapes are the ones the web sends (packages/contracts/src/passkey.ts). Tests only.

// ---- A minimal CBOR encoder (RFC 8949): unsigned and negative integers, byte and text strings, maps.

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const bytes = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

// ---- Keys and their COSE form.

export type Alg = 'ES256' | 'EdDSA';

function coseKey(alg: Alg, publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y?: string };
  const x = Buffer.from(jwk.x, 'base64url');
  if (alg === 'EdDSA') {
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 1], // kty OKP
        [3, -8], // alg EdDSA
        [-1, 6], // crv Ed25519
        [-2, x],
      ]),
    );
  }
  return cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, x],
      [-3, Buffer.from(jwk.y as string, 'base64url')],
    ]),
  );
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

const FLAG = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40 } as const;

export type Ceremony = {
  /** The base64url challenge from the options answer. */
  challenge: string;
  /** The RP ID whose hash goes into the authenticator data (default `mjk.test`). */
  rpId?: string;
  /** The origin in clientDataJSON (default `https://mjk.test`). */
  origin?: string;
  /** clientDataJSON.type (default the ceremony's own). */
  type?: string;
  /** User present / user verified flags (default both set). */
  up?: boolean;
  uv?: boolean;
  /** Backup eligible and backed up (default false). */
  backedUp?: boolean;
  /** The signature counter in the authenticator data (default this credential's next value). */
  counter?: number;
  /** Adds `crossOrigin: true` (and, with `topOrigin`, that field) to clientDataJSON. */
  crossOrigin?: boolean;
  topOrigin?: string;
};

export type SoftCredential = {
  id: Buffer;
  alg: Alg;
  publicKeyCose: Buffer;
  userHandle: Buffer;
  /** The counter the next assertion carries unless a ceremony says otherwise (0 = a counterless authenticator). */
  counter: number;
  register(c: Ceremony & { rk?: boolean; transports?: string[] }): PasskeyAttestation;
  assert(c: Ceremony & { userHandle?: Buffer; badSignature?: boolean }): PasskeyAssertion;
};

function clientData(c: Ceremony, defaultType: string): Buffer {
  const data: Record<string, unknown> = {
    type: c.type ?? defaultType,
    challenge: c.challenge,
    origin: c.origin ?? 'https://mjk.test',
    crossOrigin: c.crossOrigin ?? false,
  };
  if (c.topOrigin !== undefined) data.topOrigin = c.topOrigin;
  return Buffer.from(JSON.stringify(data), 'utf8');
}

function flags(c: Ceremony, extra = 0): number {
  let f = extra;
  if (c.up ?? true) f |= FLAG.up;
  if (c.uv ?? true) f |= FLAG.uv;
  if (c.backedUp) f |= FLAG.be | FLAG.bs;
  return f;
}

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** A new credential for `userHandle` (the member's webauthn_user_id); `counter` 0 makes it counterless. */
export function softCredential(opts: { userHandle: Buffer; alg?: Alg; counter?: number; id?: Buffer }): SoftCredential {
  const alg = opts.alg ?? 'ES256';
  const pair = alg === 'EdDSA' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cred: SoftCredential = {
    id: opts.id ?? randomBytes(16),
    alg,
    publicKeyCose: coseKey(alg, pair.publicKey),
    userHandle: opts.userHandle,
    counter: opts.counter ?? 0,
    register(c) {
      const counter = c.counter ?? cred.counter;
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(cred.id.length);
      const authData = Buffer.concat([
        sha(c.rpId ?? 'mjk.test'),
        Buffer.from([flags(c, FLAG.at)]),
        counterBytes(counter),
        Buffer.alloc(16), // AAGUID: zeros, as with attestation `none`
        idLen,
        cred.id,
        cred.publicKeyCose,
      ]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id: b64(cred.id),
        rawId: b64(cred.id),
        type: 'public-key',
        response: {
          clientDataJSON: b64(clientData(c, 'webauthn.create')),
          attestationObject: b64(attestationObject),
          ...(c.transports === undefined ? { transports: ['internal'] } : { transports: c.transports }),
        },
        ...(c.rk === undefined ? { rk: true } : { rk: c.rk }),
      };
    },
    assert(c) {
      let counter = c.counter;
      if (counter === undefined) {
        if (cred.counter > 0) cred.counter += 1;
        counter = cred.counter;
      }
      const authData = Buffer.concat([sha(c.rpId ?? 'mjk.test'), Buffer.from([flags(c)]), counterBytes(counter)]);
      const cdj = clientData(c, 'webauthn.get');
      const signed = Buffer.concat([authData, sha(cdj)]);
      let signature = alg === 'EdDSA' ? sign(null, signed, pair.privateKey) : sign('sha256', signed, pair.privateKey);
      if (c.badSignature) {
        signature = Buffer.from(signature);
        signature[signature.length - 1] = (signature[signature.length - 1] as number) ^ 0x01;
      }
      return {
        id: b64(cred.id),
        rawId: b64(cred.id),
        type: 'public-key',
        response: {
          clientDataJSON: b64(cdj),
          authenticatorData: b64(authData),
          signature: b64(signature),
          userHandle: b64(c.userHandle ?? cred.userHandle),
        },
      };
    },
  };
  return cred;
}
