import { describe, expect, it } from 'vitest';
import { CLASS_CATEGORY, categoriesOf, NEUTRAL_CLASSES, unmappedClasses } from '../../src/museums/categories.ts';
import { CATEGORIES, QID } from '../../src/museums/fields.ts';

describe('CLASS_CATEGORY', () => {
  it('holds only QIDs and the six categories, never `other`', () => {
    for (const [qid, category] of Object.entries(CLASS_CATEGORY)) {
      expect(qid).toMatch(QID);
      expect(CATEGORIES).toContain(category);
      expect(category).not.toBe('other');
    }
  });

  it('maps no neutral class', () => {
    for (const q of NEUTRAL_CLASSES) expect(CLASS_CATEGORY).not.toHaveProperty(q);
  });
});

describe('categoriesOf', () => {
  it('maps art museum and art gallery to art', () => {
    expect(categoriesOf(['Q207694'])).toEqual(['art']);
    expect(categoriesOf(['Q1007870'])).toEqual(['art']);
  });

  it('maps the history family to history', () => {
    expect(categoriesOf(['Q16735822'])).toEqual(['history']);
    expect(categoriesOf(['Q2087181'])).toEqual(['history']);
    expect(categoriesOf(['Q2772772'])).toEqual(['history']);
    expect(categoriesOf(['Q3329412'])).toEqual(['history']);
  });

  it('is unique and in CATEGORIES order whatever the input order', () => {
    expect(categoriesOf(['Q16735822', 'Q207694', 'Q2087181', 'Q207694'])).toEqual(['art', 'history']);
    expect(categoriesOf(['Q2087181', 'Q1007870'])).toEqual(['art', 'history']);
  });

  it('plain museum maps to nothing by itself', () => {
    expect(categoriesOf(['Q33506'])).toEqual(['other']);
    expect(categoriesOf(['Q33506', 'Q207694'])).toEqual(['art']);
  });

  it('is `other` when no class maps, including none at all and hostile keys', () => {
    expect(categoriesOf([])).toEqual(['other']);
    expect(categoriesOf(['Q999999999'])).toEqual(['other']);
    expect(categoriesOf(['__proto__', 'constructor', 'toString', ''])).toEqual(['other']);
  });
});

describe('unmappedClasses', () => {
  it('lists distinct unmapped classes sorted, leaving out mapped and neutral ones', () => {
    expect(unmappedClasses(['Q9', 'Q207694', 'Q33506', 'Q17431399', 'Q5', 'Q9'])).toEqual(['Q5', 'Q9']);
    expect(unmappedClasses([])).toEqual([]);
  });
});
