import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jsonForScript } from '../src/lib/json-script.ts';

const UNSAFE = /[<>&\u{2028}\u{2029}]/u;

describe('jsonForScript', () => {
  it('escapes a hostile museum name into inert JSON', () => {
    const name = '</script><script>alert(1)</script><!-- & -->';
    const out = jsonForScript({ name });
    expect(out).not.toMatch(UNSAFE);
    expect(out).not.toContain('</');
    expect(JSON.parse(out)).toEqual({ name });
  });

  it('escapes U+2028 and U+2029', () => {
    const out = jsonForScript(['a\u{2028}b\u{2029}c']);
    expect(out).toBe(`["a${'\\'}u2028b${'\\'}u2029c"]`);
  });

  it('refuses a value without JSON', () => {
    expect(() => jsonForScript(undefined)).toThrow(TypeError);
  });

  it('never leaves an unsafe character and always round-trips', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const out = jsonForScript(value);
        expect(out).not.toMatch(UNSAFE);
        expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips strings made of the unsafe characters', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('<', '>', '&', '/', '\u{2028}', '\u{2029}', 'a', '"', '\\')), (chars) => {
        const value = chars.join('');
        const out = jsonForScript(value);
        expect(out).not.toMatch(UNSAFE);
        expect(JSON.parse(out)).toBe(value);
      }),
    );
  });
});
