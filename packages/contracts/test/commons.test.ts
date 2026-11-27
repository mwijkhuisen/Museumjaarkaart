import { describe, expect, it } from 'vitest';
import { commonsFilePageUrl, licenceDeedUrl, licenceShortName } from '../src/index.ts';

describe('commons links and labels', () => {
  it.each([
    ['cc0', 'https://creativecommons.org/publicdomain/zero/1.0/', 'CC0'],
    ['pd', 'https://creativecommons.org/publicdomain/mark/1.0/', null],
    ['cc-by-4.0', 'https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'],
    ['cc-by-sa-4.0', 'https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'],
    ['cc-by-sa-3.0-nl', 'https://creativecommons.org/licenses/by-sa/3.0/nl/', 'CC BY-SA 3.0 NL'],
    ['cc-by-3.0-nl', 'https://creativecommons.org/licenses/by/3.0/nl/', 'CC BY 3.0 NL'],
    ['cc-by-2.5', 'https://creativecommons.org/licenses/by/2.5/', 'CC BY 2.5'],
  ])('%s', (code, deed, name) => {
    expect(licenceDeedUrl(code)).toBe(deed);
    expect(licenceShortName(code)).toBe(name);
  });

  it.each(['', 'cc-by-nc-4.0', 'gfdl', 'cc-by-9.0', 'javascript:alert(1)'])('%j is unknown', (code) => {
    expect(licenceDeedUrl(code)).toBeNull();
    expect(licenceShortName(code)).toBeNull();
  });

  it('builds the file page URL with underscores and percent-encoding', () => {
    expect(commonsFilePageUrl('Drents Museum.jpg')).toBe('https://commons.wikimedia.org/wiki/File:Drents_Museum.jpg');
    expect(commonsFilePageUrl('A b?c&d (1).jpg')).toBe('https://commons.wikimedia.org/wiki/File:A_b%3Fc%26d_(1).jpg');
    expect(commonsFilePageUrl('é.jpg')).toBe('https://commons.wikimedia.org/wiki/File:%C3%A9.jpg');
  });
});
