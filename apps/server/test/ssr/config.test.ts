import { describe, expect, it } from 'vitest';
import { readSsrConfig } from '../../src/ssr/config.ts';

const ok = { MJK_BRAND_NAME: 'Musea', MJK_DOMAIN: 'mjk.test' };

describe('readSsrConfig', () => {
  it('reads a valid brand and domain, trimming the brand', () => {
    expect(readSsrConfig(ok)).toEqual({ brand: 'Musea', domain: 'mjk.test' });
    expect(readSsrConfig({ ...ok, MJK_BRAND_NAME: '  Musea Nu  ' })).toEqual({ brand: 'Musea Nu', domain: 'mjk.test' });
    expect(readSsrConfig({ ...ok, MJK_DOMAIN: 'www.example-1.nl' })).toMatchObject({ domain: 'www.example-1.nl' });
    expect(readSsrConfig({ ...ok, MJK_BRAND_NAME: 'x'.repeat(60) })).toMatchObject({ brand: 'x'.repeat(60) });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(61)],
    ['a newline', 'Mu\nsea'],
    ['a NUL', 'Mu\u0000sea'],
    ['an escape', 'Mu\u001bsea'],
  ])('rejects a brand that is %s, naming the variable', (_n, brand) => {
    const r = readSsrConfig({ ...ok, MJK_BRAND_NAME: brand });
    expect(r).toEqual(expect.stringContaining('MJK_BRAND_NAME'));
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['no dot', 'localhost'],
    ['upper case', 'Example.nl'],
    ['a port', 'example.nl:8080'],
    ['a scheme', 'https://example.nl'],
    ['a path', 'example.nl/x'],
    ['spaces', 'exa mple.nl'],
    ['a leading hyphen', '-a.nl'],
    ['an empty label', 'a..nl'],
    ['a trailing dot', 'example.nl.'],
    ['a long label', `${'a'.repeat(64)}.nl`],
  ])('rejects a domain that is %s, naming the variable', (_n, domain) => {
    const r = readSsrConfig({ ...ok, MJK_DOMAIN: domain });
    expect(r).toEqual(expect.stringContaining('MJK_DOMAIN'));
  });

  it('never echoes a value in the error', () => {
    const secretish = 'evil.example/zzz-VALUE';
    const bad = readSsrConfig({ ...ok, MJK_DOMAIN: secretish });
    expect(bad).not.toContain('zzz-VALUE');
    const long = 'LONGBRAND'.repeat(10);
    const badBrand = readSsrConfig({ ...ok, MJK_BRAND_NAME: long });
    expect(badBrand).not.toContain('LONGBRAND');
  });
});
