import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BulkVisits,
  DEFAULT_SETTINGS,
  ImportRequest,
  isStorable,
  MemberMuseumsQuery,
  PublicVisit,
  PublicWishlist,
  StorableText,
  UserProfile,
  VisitCreate,
  VisitNote,
  VisitPatch,
} from '../src/index.ts';

const uuid = '0190a0a0-0000-7000-8000-000000000001';

describe('StorableText', () => {
  it('takes any well-formed text and refuses a lone surrogate or a NUL', () => {
    for (const ok of ['', 'Rijksmuseum', 'café 🎨', '\u{2028}']) expect(isStorable(ok), ok).toBe(true);
    for (const bad of ['\u{d800}', 'a\u{dfff}b', 'x\u{0}y'])
      expect(StorableText.safeParse(bad).success, bad).toBe(false);
  });
});

describe('visits', () => {
  it('VisitNote is 1 to 2,000 storable characters', () => {
    expect(VisitNote.safeParse('x'.repeat(2000)).success).toBe(true);
    for (const bad of ['', 'x'.repeat(2001), '\u{d800}', 'a\u{0}b'])
      expect(VisitNote.safeParse(bad).success).toBe(false);
  });

  it('every request schema refuses an unknown key', () => {
    expect(VisitCreate.safeParse({ museum_id: uuid, visited_on: null, extra: 1 }).success).toBe(false);
    expect(VisitPatch.safeParse({ note: 'a', extra: 1 }).success).toBe(false);
    expect(BulkVisits.safeParse({ museum_ids: [uuid], extra: 1 }).success).toBe(false);
    expect(ImportRequest.safeParse({ format: 'csv', content: '', extra: 1 }).success).toBe(false);
  });

  it('VisitPatch needs a key; null clears', () => {
    expect(VisitPatch.safeParse({}).success).toBe(false);
    expect(VisitPatch.safeParse({ note: null }).success).toBe(true);
    expect(VisitPatch.safeParse({ visited_on: null }).success).toBe(true);
  });

  it('BulkVisits takes 1 to 200 ids', () => {
    expect(BulkVisits.safeParse({ museum_ids: [] }).success).toBe(false);
    expect(BulkVisits.safeParse({ museum_ids: Array(200).fill(uuid) }).success).toBe(true);
    expect(BulkVisits.safeParse({ museum_ids: Array(201).fill(uuid) }).success).toBe(false);
  });
});

describe('MemberMuseumsQuery', () => {
  it('takes the list parameters plus visited and wishlist', () => {
    const r = MemberMuseumsQuery.parse({ q: 'rijks', province: 'NL-NH', visited: 'no', wishlist: 'yes', limit: '10' });
    expect(r).toMatchObject({ visited: 'no', wishlist: 'yes', limit: 10 });
    expect(MemberMuseumsQuery.safeParse({ visited: 'maybe' }).success).toBe(false);
    expect(MemberMuseumsQuery.safeParse({ nope: '1' }).success).toBe(false);
  });
});

describe('public shapes', () => {
  const banned = new Set(['note', 'id', 'user_id', 'created_at', 'email']);
  const keysOf = (s: unknown, seen = new Set<unknown>()): string[] => {
    if (!s || typeof s !== 'object' || seen.has(s)) return [];
    seen.add(s);
    const def = (s as { def?: Record<string, unknown> }).def;
    if (!def) return [];
    const shape = def.shape as Record<string, unknown> | undefined;
    const out = shape ? Object.keys(shape) : [];
    for (const child of [...Object.values(shape ?? {}), def.element, def.innerType, def.in, def.out])
      out.push(...keysOf(child, seen));
    return out;
  };

  it('no key of a public profile shape is a note, an id, a user id, a timestamp or an email', () => {
    fc.assert(
      fc.property(fc.constantFrom(UserProfile, PublicVisit, PublicWishlist), (schema) => {
        const keys = keysOf(schema);
        expect(keys.length).toBeGreaterThan(3);
        return keys.every((k) => !banned.has(k));
      }),
    );
  });
});

it('profiles are not indexable until the member says so', () => {
  expect(DEFAULT_SETTINGS.profile_indexable).toBe(false);
});
