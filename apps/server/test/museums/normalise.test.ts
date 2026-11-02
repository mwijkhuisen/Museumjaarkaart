import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normaliseName } from '../../src/museums/normalise.ts';

describe('normaliseName', () => {
  const table: [string, string, string][] = [
    ['lower case', 'Stedelijk Museum Alkmaar', 'stedelijk alkmaar'],
    ['stop-words are whole tokens only', 'Rijksmuseum Twenthe', 'rijksmuseum twenthe'],
    [
      'musea, het, de, van, der, den, en, stichting',
      'Stichting Musea van het Zuiden en de Delta der den',
      'zuiden delta',
    ],
    // The RCE names' legal-form and abbreviation noise (the owner's full recording, O1).
    ['stg, gem and mus', 'Nationaal Busmuseum, Stg', 'nationaal busmuseum'],
    ['gem. before a place', 'Markiezenhof, Gem. Bergen Op Zoom', 'markiezenhof bergen op zoom'],
    ['mus as a word', 'Mus Willet Holthuijzen', 'willet holthuijzen'],
    ['in as a word, not inside one', 'In de Gecroonde Duyvekater Inktmuseum', 'gecroonde duyvekater inktmuseum'],
    ["'t becomes t and is dropped", "Museum 't Kromhout", 'kromhout'],
    ['typographic apostrophe', 'Museum ’t Kromhout', 'kromhout'],
    ['place names stay', 'Museum Het Valkhof Nijmegen', 'valkhof nijmegen'],
    ['accents are removed', 'Café Müller Zoölogisch Muséum', 'cafe muller zoologisch'],
    ['sharp s', 'Straße', 'strasse'],
    ['ij ligature', 'Ĳsselmuseum', 'ijsselmuseum'],
    ['ae, oe, o-slash, l-stroke, d-stroke, thorn', 'Æ Œ Ø Ł Đ Þ', 'ae oe o l d th'],
    ['dotless i and upper-case dotted I', 'ISTANBUL İstanbul ıstanbul', 'istanbul istanbul istanbul'],
    ['punctuation to spaces', 'Boijmans-Van Beuningen, (Rotterdam)!', 'boijmans beuningen rotterdam'],
    ['digits stay', 'Museum 1940-1945', '1940 1945'],
    ['full-width forms fold through NFKD', 'ＡＢＣ １２', 'abc 12'],
    ['non-latin letters become separators', 'Museum 博物館 Zeist', 'zeist'],
    ['tabs, newlines and runs of spaces collapse', '  Stedelijk \t\n  Museum   Breda  ', 'stedelijk breda'],
    ['only stop-words leaves nothing', 'Het Museum', ''],
    ['empty', '', ''],
    ['only punctuation', '!!! ???', ''],
    ['combining marks alone are removed', 'école', 'ecole'],
  ];
  for (const [name, input, expected] of table) {
    it(name, () => expect(normaliseName(input)).toBe(expected));
  }

  it('is idempotent and only ever emits [a-z0-9 ] (arbitrary text)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => {
        const once = normaliseName(s);
        expect(once).toMatch(/^[a-z0-9 ]*$/);
        expect(once).toBe(once.trim().replace(/ {2,}/g, ' '));
        expect(normaliseName(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent on museum-like text with stop-words and accents', () => {
    const word = fc.constantFrom(
      'Museum',
      'het',
      "'t",
      'De',
      'Van',
      'Müller',
      'Straße',
      'Ĳ',
      '12',
      'Alkmaar',
      'en',
      '-',
    );
    fc.assert(
      fc.property(fc.array(word, { maxLength: 8 }), (ws) => {
        const once = normaliseName(ws.join(' '));
        expect(once).toMatch(/^[a-z0-9 ]*$/);
        expect(normaliseName(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('does not choke on a 5,000 character name', () => {
    expect(normaliseName('Ab '.repeat(2500))).toBe(Array(2500).fill('ab').join(' '));
  });
});
