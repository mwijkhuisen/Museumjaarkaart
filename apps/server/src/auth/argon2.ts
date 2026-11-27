import { argon2, randomBytes } from 'node:crypto';
import { PASSWORD_MAX } from '@mjk/contracts';
import { safeEqual } from './crypto.ts';

// Passwords through Node 26's built-in argon2id (A§9), async only (argon2Sync blocks the event
// loop). Node returns raw bytes, so the PHC string is written and parsed here. Every argon2 call
// goes through a hash gate: at most 2 at once per process, a waiter gives up after 2 s (429).

export type Argon2Params = {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
  readonly saltLength: number;
};

// m = 56 MiB, t = 2, p = 1: the highest measured m ≤ 64 MiB (8 MiB steps) whose single and paired hash
// both stay under 250 ms on the VM (docs/runbooks/accounts.md B1, 2026-11-27; 64 MiB's pair median passed
// 250 ms). Never below OWASP's floor (19 MiB), which parsePhc still accepts.
export const ARGON2_PARAMS = { memoryKiB: 57344, passes: 2, parallelism: 1, tagLength: 32, saltLength: 16 } as const;

/** The gate refused: no permit within `waitMs`. The api answers 429 with `Retry-After`. */
export class HashBusy extends Error {
  constructor() {
    super('hash_busy');
    this.name = 'HashBusy';
  }
}

export type HashGate = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
  readonly maxInFlight: number;
};

/** A FIFO semaphore; a waiter not started within `waitMs` rejects with HashBusy and never runs. */
export function createHashGate(opts = { permits: 2, waitMs: 2000 }): HashGate {
  let inFlight = 0;
  let maxInFlight = 0;
  const queue: (() => void)[] = [];
  // A released permit passes straight to the next waiter, so a newcomer never overtakes the queue.
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  };
  const acquire = () => {
    if (inFlight < opts.permits) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(new HashBusy());
      }, opts.waitMs);
      queue.push(waiter);
    });
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** The process-wide gate (A§9: at most 2 hashes at once per process). */
export const hashGate = createHashGate();

type Cost = Pick<Argon2Params, 'memoryKiB' | 'passes' | 'parallelism'>;
export type Phc = Cost & { salt: Buffer; hash: Buffer };

const derive = (gate: HashGate, password: string, salt: Buffer, cost: Cost, tagLength: number) =>
  gate.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        argon2(
          'argon2id',
          {
            message: Buffer.from(password, 'utf8'),
            nonce: salt,
            memory: cost.memoryKiB,
            passes: cost.passes,
            parallelism: cost.parallelism,
            tagLength,
          },
          (err, key) => (err ? reject(err) : resolve(key)),
        );
      }),
  );

const b64 = (b: Buffer) => b.toString('base64').replace(/=/g, '');
const phc = (p: Phc) =>
  `$argon2id$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(p.salt)}$${b64(p.hash)}`;

export async function hashPassword(
  password: string,
  params: Argon2Params = ARGON2_PARAMS,
  gate = hashGate,
): Promise<string> {
  if (password.length > PASSWORD_MAX) throw new RangeError('password too long');
  const salt = randomBytes(params.saltLength);
  const hash = await derive(gate, password, salt, params, params.tagLength);
  return phc({ memoryKiB: params.memoryKiB, passes: params.passes, parallelism: params.parallelism, salt, hash });
}

// Bounded and capped: a hostile stored hash can never make us allocate more than 64 MiB.
const PHC_RE =
  /^\$argon2id\$v=19\$m=([1-9][0-9]{0,5}),t=([1-9][0-9]?),p=([1-9])\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

/** A strict parse of our own PHC strings (16-byte salt, 32-byte hash); null for anything else. */
export function parsePhc(s: string): Phc | null {
  const m = PHC_RE.exec(s);
  if (!m) return null;
  const [memoryKiB, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (memoryKiB < 19456 || memoryKiB > 65536 || passes > 10 || parallelism > 4) return null;
  const salt = Buffer.from(m[4] as string, 'base64');
  const hash = Buffer.from(m[5] as string, 'base64');
  // The round trip refuses a spelling whose spare low bits are set.
  if (salt.length !== 16 || hash.length !== 32 || b64(salt) !== m[4] || b64(hash) !== m[5]) return null;
  return { memoryKiB, passes, parallelism, salt, hash };
}

export async function verifyPassword(password: string, stored: string, gate = hashGate): Promise<boolean> {
  if (password.length > PASSWORD_MAX) return false;
  const p = parsePhc(stored);
  if (!p) return false;
  return safeEqual(await derive(gate, password, p.salt, p, p.hash.length), p.hash);
}

export function needsRehash(stored: string, params: Argon2Params = ARGON2_PARAMS): boolean {
  const p = parsePhc(stored);
  return !p || p.memoryKiB !== params.memoryKiB || p.passes !== params.passes || p.parallelism !== params.parallelism;
}

// A PHC of random salt and random hash at the current parameters: no password matches it, and
// building it costs no hash, so the first unknown email is no slower than the next.
let dummy: string | undefined;

/** One full verify at the current parameters, so an unknown email costs what a wrong password does. */
export async function dummyVerify(password: string, gate = hashGate): Promise<false> {
  dummy ??= phc({ ...ARGON2_PARAMS, salt: randomBytes(16), hash: randomBytes(32) });
  await verifyPassword(password, dummy, gate);
  return false;
}
