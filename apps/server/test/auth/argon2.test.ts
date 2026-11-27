import { argon2 } from 'node:crypto';
import { promisify } from 'node:util';
import { PASSWORD_MAX } from '@mjk/contracts';
import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  createHashGate,
  dummyVerify,
  HashBusy,
  hashPassword,
  needsRehash,
  parsePhc,
  verifyPassword,
} from '../../src/auth/argon2.ts';

const PW = 'correct horse battery staple';
const SALT = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 zero bytes
const HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 32 zero bytes
const phc = (params: string, salt = SALT, hash = HASH, prefix = '$argon2id$v=19$') =>
  `${prefix}${params}$${salt}$${hash}`;

describe('argon2id through node:crypto', () => {
  it('is RFC 9106 argon2id version 0x13 (the v=19 the PHC string names)', async () => {
    // RFC 9106 §5.3's test vector.
    const tag = await promisify(argon2)('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('hashes to a PHC string at or above the floor, and verifies it', async () => {
    const stored = await hashPassword(PW);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=57344,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    const p = parsePhc(stored);
    expect(p).not.toBeNull();
    expect(p?.memoryKiB).toBeGreaterThanOrEqual(19456);
    expect(p?.passes).toBeGreaterThanOrEqual(2);
    expect(p?.parallelism).toBeGreaterThanOrEqual(1);
    expect(needsRehash(stored)).toBe(false);
    const [right, wrong] = await Promise.all([verifyPassword(PW, stored), verifyPassword(`${PW}!`, stored)]);
    expect(right).toBe(true);
    expect(wrong).toBe(false);
    expect(await hashPassword(PW)).not.toBe(stored);
  });

  it('refuses a password over PASSWORD_MAX without hashing', async () => {
    const long = 'a'.repeat(PASSWORD_MAX + 1);
    await expect(hashPassword(long)).rejects.toThrow(RangeError);
    expect(await verifyPassword(long, phc('m=19456,t=2,p=1'))).toBe(false);
  });

  it('dummyVerify resolves false', async () => {
    expect(await dummyVerify(PW)).toBe(false);
  });
});

describe('parsePhc', () => {
  it('reads a well-formed string', () => {
    expect(parsePhc(phc('m=65536,t=10,p=4'))).toEqual({
      memoryKiB: 65536,
      passes: 10,
      parallelism: 4,
      salt: Buffer.alloc(16),
      hash: Buffer.alloc(32),
    });
  });

  it.each([
    ['memory below the floor', phc('m=19455,t=2,p=1')],
    ['memory over 64 MiB', phc('m=65537,t=2,p=1')],
    ['m=1048576', phc('m=1048576,t=2,p=1')],
    ['t=0', phc('m=19456,t=0,p=1')],
    ['t=11', phc('m=19456,t=11,p=1')],
    ['p=0', phc('m=19456,t=2,p=0')],
    ['p=5', phc('m=19456,t=2,p=5')],
    ['a leading zero', phc('m=019456,t=2,p=1')],
    ['a leading zero in t', phc('m=19456,t=02,p=1')],
    ['a sign', phc('m=+19456,t=2,p=1')],
    ['parameters in another order', phc('t=2,m=19456,p=1')],
    ['a missing parameter', phc('m=19456,t=2')],
    ['an extra parameter', phc('m=19456,t=2,p=1,k=1')],
    ['argon2i', phc('m=19456,t=2,p=1', SALT, HASH, '$argon2i$v=19$')],
    ['v=16', phc('m=19456,t=2,p=1', SALT, HASH, '$argon2id$v=16$')],
    ['no version', phc('m=19456,t=2,p=1', SALT, HASH, '$argon2id$')],
    ['a padded salt', phc('m=19456,t=2,p=1', `${SALT}==`)],
    ['a 15-byte salt', phc('m=19456,t=2,p=1', SALT.slice(0, 20))],
    ['a 33-byte hash', phc('m=19456,t=2,p=1', SALT, `${HASH}AA`)],
    ['a 31-byte hash', phc('m=19456,t=2,p=1', SALT, HASH.slice(0, 42))],
    ['base64url characters', phc('m=19456,t=2,p=1', `${SALT.slice(0, 21)}_`)],
    ['spare low bits set', phc('m=19456,t=2,p=1', `${SALT.slice(0, 21)}B`)],
    ['a trailing newline', `${phc('m=19456,t=2,p=1')}\n`],
    ['an empty string', ''],
  ])('refuses %s', (_, s) => {
    expect(parsePhc(s)).toBeNull();
  });

  it('needsRehash for other parameters and for an unparseable string', () => {
    expect(needsRehash(phc('m=57344,t=2,p=1'))).toBe(false);
    // A hash at the old floor still parses (so it verifies) and is redone at sign-in.
    expect(parsePhc(phc('m=19456,t=2,p=1'))).not.toBeNull();
    expect(needsRehash(phc('m=19456,t=2,p=1'))).toBe(true);
    expect(needsRehash(phc('m=57344,t=2,p=1'), { ...ARGON2_PARAMS, memoryKiB: 47104 })).toBe(true);
    expect(needsRehash(phc('m=57344,t=1,p=1'))).toBe(true);
    expect(needsRehash(phc('m=57344,t=2,p=2'))).toBe(true);
    expect(needsRehash('nonsense')).toBe(true);
  });

  it('verifyPassword is false for an unparseable string', async () => {
    expect(await verifyPassword(PW, phc('m=1048576,t=2,p=1'))).toBe(false);
  });
});

describe('the hash gate', () => {
  const tick = () => new Promise((r) => setTimeout(r, 1));

  it('runs at most two at once, first in first out', async () => {
    const gate = createHashGate();
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        gate.run(async () => {
          order.push(i);
          expect(gate.inFlight).toBeLessThanOrEqual(2);
          await tick();
        }),
      ),
    );
    expect(gate.maxInFlight).toBe(2);
    expect(gate.inFlight).toBe(0);
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('rejects a waiter with HashBusy after waitMs, and it never runs', async () => {
    const gate = createHashGate({ permits: 2, waitMs: 50 });
    let unblock = () => {};
    const blocked = new Promise<void>((r) => {
      unblock = r;
    });
    const blockers = [gate.run(() => blocked), gate.run(() => blocked)];
    let ran = false;
    await expect(
      gate.run(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(HashBusy);
    unblock();
    await Promise.all(blockers);
    await tick();
    expect(ran).toBe(false);
    expect(gate.inFlight).toBe(0);
    expect(await gate.run(async () => 'next')).toBe('next');
  });

  it('releases the permit when fn throws', async () => {
    const gate = createHashGate({ permits: 1, waitMs: 50 });
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(
      gate.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(gate.inFlight).toBe(0);
    expect(await gate.run(async () => 1)).toBe(1);
  });

  it('carries the argon2 calls', async () => {
    const gate = createHashGate({ permits: 1, waitMs: 50 });
    let release = () => {};
    const held = gate.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await expect(dummyVerify(PW, gate)).rejects.toBeInstanceOf(HashBusy);
    await expect(verifyPassword(PW, phc('m=19456,t=2,p=1'), gate)).rejects.toBeInstanceOf(HashBusy);
    await expect(hashPassword(PW, ARGON2_PARAMS, gate)).rejects.toBeInstanceOf(HashBusy);
    release();
    await held;
  });
});
