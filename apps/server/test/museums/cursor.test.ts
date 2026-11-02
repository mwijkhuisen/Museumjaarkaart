import { Cursor } from '@mjk/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type PageCursor } from '../../src/museums/cursor.ts';

// The keyset cursor of GET /museums (A§14): base64url of compact JSON in two modes, decoded strictly.

const ID = '123e4567-e89b-42d3-a456-426614174000';
const b64 = (text: string) => Buffer.from(text).toString('base64url');

/** A sort key: up to 250 code points of any plane, no NUL, no lone surrogate. */
const sortKey = fc
  .array(fc.oneof(fc.integer({ min: 1, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), { maxLength: 250 })
  .map((cps) => String.fromCodePoint(...cps));
const uuid = fc.uuid();
const score = fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true });

describe('encodeCursor and decodeCursor', () => {
  it('round-trips the name mode', () => {
    fc.assert(
      fc.property(sortKey, uuid, (k, i) => {
        const c: PageCursor = { m: 'n', k, i };
        const text = encodeCursor(c);
        expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeCursor(text)).toEqual({ ok: true, cursor: c });
      }),
    );
  });

  it('round-trips the search mode, scores included', () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 2, 3), score, sortKey, uuid, (t, s, k, i) => {
        const c: PageCursor = { m: 's', t, s, k, i };
        const back = decodeCursor(encodeCursor(c));
        expect(back).toEqual({ ok: true, cursor: c });
        if (back.ok && back.cursor.m === 's') expect(Object.is(back.cursor.s, s === 0 ? 0 : s)).toBe(true);
      }),
    );
  });

  it('writes compact JSON with the keys in a fixed order', () => {
    const decode = (c: PageCursor) => Buffer.from(encodeCursor(c), 'base64url').toString();
    expect(decode({ m: 'n', k: 'a', i: ID })).toBe(`{"m":"n","k":"a","i":"${ID}"}`);
    expect(decode({ m: 's', t: 2, s: 0.5, k: 'a', i: ID })).toBe(`{"m":"s","t":2,"s":0.5,"k":"a","i":"${ID}"}`);
  });

  it('normalises -0 to 0', () => {
    const text = encodeCursor({ m: 's', t: 1, s: -0, k: 'a', i: ID });
    expect(Buffer.from(text, 'base64url').toString()).toContain('"s":0,');
    const back = decodeCursor(text);
    expect(back.ok && back.cursor.m === 's' && Object.is(back.cursor.s, 0)).toBe(true);
  });

  it('refuses to encode a score that no cursor may hold', () => {
    for (const s of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => encodeCursor({ m: 's', t: 1, s, k: 'a', i: ID })).toThrow(RangeError);
    }
  });

  it('fits the longest key (250 four-byte characters) into the contract Cursor', () => {
    const key = '\u{1F3DB}'.repeat(250);
    expect(Buffer.byteLength(key)).toBe(1000);
    for (const c of [
      { m: 'n', k: key, i: ID },
      { m: 's', t: 3, s: Number.MAX_VALUE, k: key, i: ID },
      { m: 's', t: 3, s: 5e-324, k: key, i: ID },
    ] as const) {
      const text = encodeCursor(c);
      expect(text.length).toBeLessThan(2048);
      expect(Cursor.safeParse(text).success).toBe(true);
      expect(decodeCursor(text)).toEqual({ ok: true, cursor: c });
    }
    // The old maximum of 400 would have refused it.
    expect(encodeCursor({ m: 'n', k: key, i: ID }).length).toBeGreaterThan(400);
  });

  it('fits the worst key: 250 characters that JSON escapes as \\u00XX', () => {
    const key = '\u0001'.repeat(250);
    const c = { m: 's', t: 3, s: Number.MAX_VALUE, k: key, i: ID } as const;
    const text = encodeCursor(c);
    expect(text.length).toBeGreaterThan(2048);
    expect(text.length).toBeLessThan(4096);
    expect(Cursor.safeParse(text).success).toBe(true);
    expect(decodeCursor(text)).toEqual({ ok: true, cursor: c });
  });
});

describe('malformed cursors', () => {
  const searchOk = { m: 's', t: 1, s: 0.5, k: 'a', i: ID };
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['not base64url (space)', 'ab cd'],
    ['not base64url (plus, slash)', 'ab+/'],
    ['not base64url (padding)', `${b64('{"m":"n","k":"a","i":"x"}')}=`],
    ['not base64url (non-ASCII)', 'abé'],
    ['non-canonical base64url (stray bits)', `${b64('{}').slice(0, -1)}${'B'}`],
    ['longer than any cursor', 'A'.repeat(2049)],
    ['not JSON', b64('hello')],
    ['truncated JSON', b64('{"m":"n","k":"a"')],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url')],
    ['JSON null', b64('null')],
    ['JSON array', b64('[]')],
    ['JSON string', b64('"n"')],
    ['JSON number', b64('1')],
    ['an empty object', b64('{}')],
    ['no mode', b64(JSON.stringify({ k: 'a', i: ID }))],
    ['an unknown mode', b64(JSON.stringify({ m: 'x', k: 'a', i: ID }))],
    ['mode as a number', b64(JSON.stringify({ m: 1, k: 'a', i: ID }))],
    ['name mode with an extra key', b64(JSON.stringify({ m: 'n', k: 'a', i: ID, t: 1 }))],
    ['name mode with search keys', b64(JSON.stringify({ m: 'n', t: 1, s: 0.5, k: 'a', i: ID }))],
    ['search mode without a score', b64(JSON.stringify({ m: 's', t: 1, k: 'a', i: ID }))],
    ['search mode with an extra key', b64(JSON.stringify({ ...searchOk, x: 1 }))],
    ['name mode without a key', b64(JSON.stringify({ m: 'n', i: ID }))],
    ['a key that is not a string', b64(JSON.stringify({ m: 'n', k: 1, i: ID }))],
    ['a key with a NUL', b64(JSON.stringify({ m: 'n', k: 'a\u0000', i: ID }))],
    ['a key with a lone surrogate', b64(`{"m":"n","k":"\\ud800","i":"${ID}"}`)],
    ['a key over 1000 characters', b64(JSON.stringify({ m: 'n', k: 'a'.repeat(1001), i: ID }))],
    ['an id that is not a uuid', b64(JSON.stringify({ m: 'n', k: 'a', i: 'nope' }))],
    ['a uuid with a suffix', b64(JSON.stringify({ m: 'n', k: 'a', i: `${ID}x` }))],
    ['a uuid with SQL', b64(JSON.stringify({ m: 'n', k: 'a', i: `${ID}'; DROP TABLE museum;--` }))],
    ['a uuid with a newline at the end', b64(JSON.stringify({ m: 'n', k: 'a', i: `${ID}\n` }))],
    ['an id that is a number', b64(JSON.stringify({ m: 'n', k: 'a', i: 1 }))],
    ['a tier of 0', b64(JSON.stringify({ ...searchOk, t: 0 }))],
    ['a tier of 4', b64(JSON.stringify({ ...searchOk, t: 4 }))],
    ['a tier of 1.5', b64(JSON.stringify({ ...searchOk, t: 1.5 }))],
    ['a tier as a string', b64(JSON.stringify({ ...searchOk, t: '1' }))],
    ['a negative score', b64(JSON.stringify({ ...searchOk, s: -0.1 }))],
    ['a score of null (what NaN becomes in JSON)', b64(JSON.stringify({ ...searchOk, s: Number.NaN }))],
    ['a score as a string', b64(JSON.stringify({ ...searchOk, s: '0.5' }))],
    ['a score of NaN as a string', b64(JSON.stringify({ ...searchOk, s: 'NaN' }))],
    ['an infinite score (1e999)', b64(`{"m":"s","t":1,"s":1e999,"k":"a","i":"${ID}"}`)],
    ['a negative infinite score', b64(`{"m":"s","t":1,"s":-1e999,"k":"a","i":"${ID}"}`)],
    ['a score as an array', b64(JSON.stringify({ ...searchOk, s: [0.5] }))],
    ['a score as a boolean', b64(JSON.stringify({ ...searchOk, s: true }))],
  ];

  it.each(cases)('is a typed failure, not a throw: %s', (_name, text) => {
    expect(decodeCursor(text)).toEqual({ ok: false });
  });

  it('accepts a huge but finite score, and an id in capitals', () => {
    expect(decodeCursor(b64(`{"m":"s","t":3,"s":1.7976931348623157e308,"k":"a","i":"${ID}"}`)).ok).toBe(true);
    expect(decodeCursor(b64(JSON.stringify({ m: 'n', k: 'a', i: ID.toUpperCase() }))).ok).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(() => decodeCursor(text)).not.toThrow();
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const r = decodeCursor(Buffer.from(bytes).toString('base64url'));
        expect(typeof r.ok).toBe('boolean');
      }),
    );
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => decodeCursor(b64(JSON.stringify(value)))).not.toThrow();
      }),
    );
  });
});
