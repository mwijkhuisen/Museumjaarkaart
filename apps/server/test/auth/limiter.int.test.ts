import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPrefixes } from '../../src/api/middleware/client-address.ts';
import { BUCKETS, type Bucket, hit, hitIp, peek, refund } from '../../src/auth/limiter.ts';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

let testDb: TestDb;
let pool: pg.Pool;
let db: Db;
let admin: pg.Client;

beforeAll(async () => {
  testDb = await createMigratedDb();
  pool = new pg.Pool({ connectionString: testDb.urls.mjk_api, max: 10 });
  db = createDb(pool);
  admin = new pg.Client({ connectionString: testDb.urls.admin });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
  await testDb?.drop();
});

const T0 = new Date('2026-12-01T10:00:00Z'); // a multiple of 900 s and of 3600 s

describe('window', () => {
  const b = BUCKETS.codeEmailPrefix;
  it('allows `limit` hits, refuses the next, and the next window starts clean', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit(db, b, 'win-a', { at: new Date(T0.getTime() + 10_000) }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results[3]?.retryAfterS).toBe(890);
    expect(results[3]?.windowStart).toEqual(T0);
    const next = await hit(db, b, 'win-a', { at: new Date(T0.getTime() + b.windowS * 1000) });
    expect(next).toMatchObject({ count: 1, allowed: true, retryAfterS: 900 });
  });

  it('retryAfterS is within 1..windowS with the database clock', async () => {
    const r = await hit(db, b, 'win-now');
    expect(r.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(r.retryAfterS).toBeLessThanOrEqual(b.windowS);
    expect(await peek(db, b, 'win-now')).toBe(1);
    expect(await peek(db, b, 'win-never')).toBe(0);
  });

  it('refuses a key over 100 characters or empty before SQL', async () => {
    await expect(hit(db, b, 'x'.repeat(101))).rejects.toThrow('limiter_key');
    await expect(hit(db, b, '')).rejects.toThrow('limiter_key');
    await expect(hit(db, b, 'x'.repeat(100))).resolves.toMatchObject({ count: 1 });
  });
});

describe('parallel', () => {
  it('50 parallel hits give exactly `limit` allowed and counts 1..50', async () => {
    const b = BUCKETS.passwordEmail;
    const rs = await Promise.all(Array.from({ length: 50 }, () => hit(db, b, 'par-a', { at: T0 })));
    expect(rs.filter((r) => r.allowed)).toHaveLength(b.limit);
    expect(rs.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('property', () => {
  let run = 0;
  it('allowed hits per (key, window) equal min(limit, hits)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom('k1', 'k2', 'k3'), fc.integer({ min: 0, max: 3 * 600 - 1 })), {
          maxLength: 30,
        }),
        async (ops) => {
          const bucket: Bucket = { name: `prop_${run++}`, limit: 3, windowS: 600 };
          const allowed = new Map<string, number>();
          const total = new Map<string, number>();
          for (const [key, offset] of ops) {
            const r = await hit(db, bucket, key, { at: new Date(T0.getTime() + offset * 1000) });
            const cell = `${key}/${Math.floor(offset / 600)}`;
            total.set(cell, (total.get(cell) ?? 0) + 1);
            if (r.allowed) allowed.set(cell, (allowed.get(cell) ?? 0) + 1);
          }
          for (const [cell, n] of total) expect(allowed.get(cell) ?? 0).toBe(Math.min(bucket.limit, n));
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('refund', () => {
  it('gives back exactly one slot in the exact window, never below 0', async () => {
    const b = BUCKETS.verifyFailPrefix;
    const at = new Date(T0.getTime() + 5_000);
    const h1 = await hit(db, b, 'ref-a', { at });
    await hit(db, b, 'ref-a', { at });
    await refund(db, b, 'ref-a', h1.windowStart);
    expect(await peek(db, b, 'ref-a', { at })).toBe(1);
    // another window is untouched
    const later = new Date(T0.getTime() + b.windowS * 1000 + 5_000);
    await hit(db, b, 'ref-a', { at: later });
    await refund(db, b, 'ref-a', h1.windowStart);
    await refund(db, b, 'ref-a', h1.windowStart);
    expect(await peek(db, b, 'ref-a', { at })).toBe(0);
    expect(await peek(db, b, 'ref-a', { at: later })).toBe(1);
  });
});

describe('hitIp', () => {
  const b: Bucket = { name: 'ip_test', limit: 3, windowS: 3_600 };
  const at = { at: T0 };

  it('is null for an unknown client', async () => {
    expect(await hitIp(db, b, undefined)).toBeNull();
  });

  it('IPv4 clients of one /24 share the limit', async () => {
    const rs = [];
    for (const host of [1, 2, 3, 4]) rs.push(await hitIp(db, b, withPrefixes(`198.51.100.${host}`), at));
    expect(rs.map((r) => r?.allowed)).toEqual([true, true, true, false]);
  });

  it('IPv6 addresses of one /56 share the limit', async () => {
    const rs = [];
    for (const a of ['2001:db8:a:100::1', '2001:db8:a:1ff::2', '2001:db8:a:101::3', '2001:db8:a:100::4']) {
      rs.push(await hitIp(db, b, withPrefixes(a), at));
    }
    expect(rs.map((r) => r?.allowed)).toEqual([true, true, true, false]);
  });

  it('five /56s of one /48 hit the /48 limit of 12 on the 13th hit', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 13; i++) {
      const net = (i % 5) + 1; // five /56s: 2001:db8:b:100, 200 ... 500, each at most 3 hits
      const r = await hitIp(db, b, withPrefixes(`2001:db8:b:${net}00::${i + 1}`), at);
      results.push(r?.allowed ?? false);
    }
    expect(results.slice(0, 12).every(Boolean)).toBe(true);
    expect(results[12]).toBe(false);
  });

  it('the table holds only prefixes and email-key hex, never an address', async () => {
    const { rows } = await admin.query<{ key: string }>('SELECT DISTINCT key FROM rate_limit WHERE bucket = $1', [
      b.name,
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const { key } of rows) expect(key).toMatch(/\/(24|48|56)$|^[0-9a-f]{64}$/);
    for (const { key } of rows) expect(key).not.toMatch(/::\d+$/);
  });
});
