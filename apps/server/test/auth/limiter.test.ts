import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { withPrefixes } from '../../src/api/middleware/client-address.ts';
import { BUCKETS, emailKey, enforce, ipKeys } from '../../src/auth/limiter.ts';
import { memoryLogger } from '../../src/lib/log.ts';
import { makeTestKeys } from './test-keys.ts';

describe('ipKeys', () => {
  it('IPv4 has the /24 only', () => {
    expect(ipKeys(withPrefixes('203.0.113.77'))).toEqual([{ key: '203.0.113.0/24', factor: 1 }]);
  });

  it('IPv6 has the /56 at 1 and the /48 at 4', () => {
    expect(ipKeys(withPrefixes('2001:db8:1234:5600::1'))).toEqual([
      { key: '2001:db8:1234:5600::/56', factor: 1 },
      { key: '2001:db8:1234::/48', factor: 4 },
    ]);
  });

  it('shares the /56 inside one /56, and only the /48 across /56s of one /48', () => {
    const a = ipKeys(withPrefixes('2001:db8:1234:5601::1'));
    const b = ipKeys(withPrefixes('2001:db8:1234:56ff:aaaa::2'));
    const c = ipKeys(withPrefixes('2001:db8:1234:5700::1'));
    expect(a?.[0]).toEqual(b?.[0]);
    expect(a?.[0]).not.toEqual(c?.[0]);
    expect(a?.[1]).toEqual(c?.[1]);
  });

  it('is null for an unknown client', () => {
    expect(ipKeys(undefined)).toBeNull();
  });
});

describe('emailKey', () => {
  const keys = makeTestKeys();
  it('is 64 hex, deterministic, pepper-dependent and never holds the email', () => {
    const k = emailKey(keys, 'ada@example.org');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(emailKey(keys, 'ada@example.org')).toBe(k);
    expect(emailKey(makeTestKeys(), 'ada@example.org')).not.toBe(k);
    expect(emailKey(keys, 'bob@example.org')).not.toBe(k);
    expect(k).not.toContain('ada');
  });
});

describe('enforce', () => {
  const bucket = BUCKETS.codePrefix;
  const refused = { count: 21, allowed: false, retryAfterS: 42, windowStart: new Date(0) };

  it('passes an allowed hit silently', () => {
    const { logger, lines } = memoryLogger();
    enforce(logger, bucket, { ...refused, count: 1, allowed: true });
    expect(lines()).toEqual([]);
  });

  it('throws rate_limited with retryAfter and logs only the bucket', () => {
    const { logger, lines } = memoryLogger();
    let err: unknown;
    try {
      enforce(logger, bucket, refused);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('rate_limited');
    expect((err as ApiError).retryAfter).toBe(42);
    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ bucket: 'code_prefix', msg: 'rate_limited' });
    expect(Object.keys(line ?? {}).sort()).toEqual(['bucket', 'level', 'msg', 'role', 'time']);
  });

  it('an unknown client (null) is refused with 60 s and client_unknown', () => {
    const { logger, lines } = memoryLogger();
    let err: unknown;
    try {
      enforce(logger, bucket, null);
    } catch (e) {
      err = e;
    }
    expect((err as ApiError).code).toBe('rate_limited');
    expect((err as ApiError).retryAfter).toBe(60);
    expect(lines()[0]).toMatchObject({ bucket: 'code_prefix', reason: 'client_unknown' });
  });
});
