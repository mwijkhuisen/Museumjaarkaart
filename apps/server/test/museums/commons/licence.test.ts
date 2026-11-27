import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LICENCE_RE, licenceCode } from '../../../src/museums/commons/licence.ts';

describe('licenceCode', () => {
  it.each([
    ['cc0', 'cc0'],
    ['pd', 'pd'],
    ['CC-BY-SA-4.0', 'cc-by-sa-4.0'],
    ['  cc-by-3.0 ', 'cc-by-3.0'],
    ['cc-by-sa-3.0-nl', 'cc-by-sa-3.0-nl'],
    ['cc-by-2.5', 'cc-by-2.5'],
    ['cc-by-1.0', 'cc-by-1.0'],
  ])('allows %j as %s', (raw, code) => {
    expect(licenceCode(raw)).toEqual({ ok: true, code });
  });

  it.each([
    'cc-by-nc-4.0',
    'cc-by-nd-4.0',
    'cc-by-nc-sa-3.0',
    'gfdl',
    'gfdl-1.2',
    'pd-old',
    'cc-by-4.1',
    'cc-by-5.0',
    'cc-by-sa-4.0-nld',
    'cc-by-4.0\nx',
    'ccz',
    'unknown',
  ])('skips %j as not allowed', (raw) => {
    expect(licenceCode(raw)).toEqual({ ok: false, code: 'commons_licence_not_allowed' });
  });

  it.each([null, undefined, '', '   '])('skips %j as missing', (raw) => {
    expect(licenceCode(raw)).toEqual({ ok: false, code: 'commons_licence_missing' });
  });

  it('never allows a string outside the regex (fast-check)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (raw) => {
        const r = licenceCode(raw);
        const norm = raw.trim().toLowerCase();
        if (r.ok) {
          expect(r.code).toBe(norm);
          expect(LICENCE_RE.test(norm)).toBe(true);
        } else if (norm !== '') {
          expect(LICENCE_RE.test(norm)).toBe(false);
        }
      }),
    );
  });

  it('every allowed combination matches, nothing near it does (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '-sa'),
        fc.constantFrom('1.0', '2.0', '2.5', '3.0', '4.0'),
        fc.constantFrom('', '-nl', '-de'),
        (sa, v, port) => {
          expect(licenceCode(`cc-by${sa}-${v}${port}`).ok).toBe(true);
          expect(licenceCode(`cc-by${sa}-nc-${v}${port}`).ok).toBe(false);
        },
      ),
    );
  });
});
